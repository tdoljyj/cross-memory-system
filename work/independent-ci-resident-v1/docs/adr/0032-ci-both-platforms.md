# ADR 0032：CI 两个平台都测；本地验证改为可选；手拼 `file://` 入口判断从机制上堵死

- 状态：第 1 步已合入（#1094）；第 2 步已实现（分支 `claude/ci-both-platforms-pr2`：工作流生效并登记，检查**非必需**）；观察、设为必需并把本地验证改为可选待做（见 §7）
- 日期：2026-11-14
- 编号：0030 是通用升级（#1092），0031 是去掉终态准入（#1093），所以取 0032
- Owner Decision：统领原则（`42d5bf8d`：最终系统极简、低耗、高效，错误从机制上堵死）；看板缺陷第 14 行（重大），Owner 已批“开做”
- 代码：`scripts/ci/ci-required-selection.mjs`（`SUITE_PLATFORMS`、`selectSuites` 的 `platform`、`runSelected`、`--run-selected`）、`.github/workflows/clued-required-tests-windows.yml`、`scripts/ci/main-entry-realpath.test.mjs`（`buildsFileUrlByHand`）、`src/service-main.mjs`、`src/companion-main.mjs`、`work/twentyfirst-forward/derive-getter-module.mjs`
- 测试（修复前都失败）：`scripts/ci/ci-required-selection.test.mjs` “a change that breaks only on Windows fails ci-suites-windows and passes the Linux side …”（第 2 步起从 `.github/workflows` 里的工作流读出作业、检查名和命令；没有这个工作流就失败）、“each platform is selected only the suites declared for it …”、“the Windows job of the workflow selects and runs with the trusted selection …”；`scripts/ci/main-entry-realpath.test.mjs` “no source file builds a file: URL by hand …”、“a file: URL built by hand is recognised …”

## 1. 现场

- #1092 推送前跑了本地验证（默认模式，只跑 Windows），全绿；推上去后 Linux 的 `ci-suites` 失败。根因：`tools/build-package.mjs` 用手拼的 `file:///` URL 判断自己是不是入口，POSIX 路径永远对不上，命令行在 Linux 上什么也不做却返回 0（已在 `3e2da768` 修好）。
- 查实的现状是两个平台各缺一半：
  - 三项测试检查 `ci-suites`、`clued-cloud-tests`、`migration-verify` 只在自建 Linux 池上跑（`clued-required-tests.yml`）。常驻层和 Source v2 在生产里跑在 Windows 上的代码，CI 从来不在 Windows 上测。
  - 本地验证默认只跑 Windows，Linux 侧的问题本地发现不了。
- 所以“推送前本地验证”这条规矩挡不住这类错：它靠人记得跑、靠人跑对模式，而且就算跑了也只覆盖一半。

## 2. 决定

1. **CI 两个平台都测。** 同一个选择函数、同一份命令，在 Linux 和 Windows 上各跑一遍；任一边失败，那一边的必需检查失败，PR 合不进去。
2. **本地验证改为可选自查，不挡推送，但只在 `ci-suites-windows` 成为必需检查的同一步生效。** 在那之前，推送前的本地验证仍是现行规则（它默认跑的正是 Windows），不留“Windows 既没有 CI 测、也没有本地验证兜底”的空窗。工具保留。
3. **手拼 `file://` 从机制上堵死。** 静态检查拦下所有手拼写法，现有的三处改掉。

## 3. 链路，以及每一环防什么

| 环 | 做什么 | 防什么 |
|---|---|---|
| 选择（`selectSuites(check, files, platform)`，trusted base 上的那一份） | 改动路径选出套件，再按 `SUITE_PLATFORMS` 留下这个平台声明要跑的 | PR 不能缩小自己的选择；两边用的是同一份路径规则，不会一边选了另一边漏选 |
| 平台声明（`SUITE_PLATFORMS`，只在选择文件里） | 没列的套件两边都跑；列了的写明只在哪边跑、为什么 | 唯一来源：工作流、文档、本地工具都不另抄清单。新套件默认两边都跑，要少跑必须写理由 |
| Linux 作业（现有 `ci-suites` 等三项，不变） | 跑 Linux 侧选中的套件 | Linux 上才出的错（#1092） |
| Windows 作业 `ci-suites-windows`（新） | 一步：`node trusted/…/ci-required-selection.mjs --run-selected ci-suites --root candidate` | Windows 上才出的错。作业只有这一条命令，没有别的能让它变绿或变红 |
| 准入门（同一个 `admission-gate` 作业，逐字节相同） | 只有已准入的 head 才跑；没放行时作业名是 `ci-suites-windows-skipped` | 未准入的 PR 代码不在节点上执行；跳过的作业不会被当成成功（必需检查缺失，fail closed） |
| runner 上的 job-started 钩子（现有，`scripts/runner`） | 每个作业开始前在 runner 机器上再核一次准入 | 改工作流的分支去不掉它 |
| 规则集必需检查（§7 第 4 步） | `ci-suites-windows` 钉 GitHub Actions（App `15368`） | 别的 App 发同名检查顶替；失败的 PR 被合入 |
| 第 8 段 `requiredCheckFailure`（现有） | 读**实际规则集**里的必需检查；确认失败就不入队、不延长，已入队则归还合并位 | 测试失败的 PR 占着合并位。新检查进了规则集就自动算上，不用改常驻代码 |
| ADR 0018 落地条件第 5 项（现有） | 规则集里不由 App `5368905` 产生的必需检查都要在 S 上成功 | 列车把 Windows 侧没过的提交推上 main。同样自动算上 |

## 4. Windows 侧由谁执行

**每个常驻节点宿主机上已有的 Windows Actions runner**（`windows-general-v1`：服务账户 `clued-runner`，标签 `self-hosted, Windows, X64, clued, pool-general, trust-internal, cap-node24, cap-python312`；DESK 是 `clued-ci-company-win-01`，见 `scripts/ci/self-hosted/node-profiles.json`）。哪台空闲哪台接，不按台写。

不由常驻服务或 companion 来跑，原因：

- 常驻服务不执行 PR 代码（不变量 3，ADR 0001），也不联网；companion 是 Owner 本人的会话，更不能跑 PR 的测试。让它们跑，等于为了测试去打破全系统最要紧的两条隔离。
- Windows runner 本来就是“在这台宿主机上、以专用低权账户、经准入后执行仓库代码”的那个部件，Linux 侧的三项检查用的就是它在 WSL 里的同类。复用它，执行、调度、准入、收据都是现成的：
  - **执行**：runner 自带的 Node 24 和 Python 3.12，不下载任何东西（网络抖动不影响）。
  - **调度**：Actions 的队列；同一 PR 新 head 取消旧 head 的运行（`concurrency`）。
  - **让路**：每台宿主机只有一个 Windows runner，同一时刻最多一个 Windows 作业，套件在作业里串行跑。和 Linux 侧一样不等常驻批次（Linux 作业今天就和批次同时跑在同一台机器上）。观察期（§7 第 3 步，已列为待观察项）里如果出现 `e0a5630d` 那类“宿主机太忙、第 2 段转发放弃”，再给这一步加有界让路（`local-verify.mjs#yieldToResident` 已有实现）；现在不加，因为 `clued-runner` 账户读不读得到 `status.json` 没有实证，加了可能是死代码。
  - **收据**：check run（App `15368`）和作业日志、步骤摘要（逐套件写 passed / failed）。
- 常驻包因此**不需要改**，不碰冻结通道（`upgrader/src`、`upgrade-apply.ps1`），不需要重装或升级任何节点。

**为什么是单独的工作流文件**（`clued-required-tests-windows.yml`），而不是给 `clued-required-tests.yml` 加一个作业：

- `clued-required-tests.yml` 的逐字节内容是登记过的复合 Source（`clued-workflow-profile.mjs#REQUIRED_TESTS_SOURCE`：blob、三个角色各自的摘要；`clued-gated-proof.mjs` 写死“四个作业、三个 primary”）。加一个作业要重写这套证明。
- 单独的文件可以单独停用：Windows 侧出问题时在 GitHub 上禁用这一个工作流（再由 Owner 把它从规则集里拿掉），Linux 三项不受影响。
- 代价是每个 PR 多一个准入门作业（Linux runner 上轮询约半分钟）。

## 5. 哪些套件在哪边跑

规则：**套件跑在它测的代码在生产里运行的平台上；一个提交只有一个答案的检查只跑一次。**

| 平台 | 套件 |
|---|---|
| 两边都跑（表里不列） | `resident-node`、`resident-python`、`offline-drill`、`source-v2-node`、`source-v2-python`、`node-governance`、`admission-self-tests`、`powershell-count`、`selection` |
| 只在 Linux | `clued-cloud`、`production-schema`（应用只在 Linux 上构建、测试、发布）；`compute-panel`；`components`、`runner-budget-policy`、`pinned-registries`、`mechanical-outputs`、`ci-deps-entry`（一个提交一个答案，或依赖只在 Linux 池上有的依赖仓） |
| 暂时只在 Linux | `reinstall-python`：它测的重装工具跑在 Windows 上，本该两边都跑；但它今天在 Windows 的 main 上有 10 个失败（`test_resume_launcher` 等）。这是一个要登记、要修的缺陷，修好后删掉表里这一行 |

某个套件只属于一个平台时，另一边选出来的是空集，什么也不跑，那一边照样通过（“这个改动不碰本平台的任何套件”）。

## 6. 几个要对上的问题

- **同一提交的同一检查只跑一次（ADR 0003）。** 检查的身份是（head，检查名）。`ci-suites-windows` 是另一项检查，每个 head 跑一次；它和 `ci-suites` 选的是同一批套件，但平台不同，这正是要的，不是重复跑。平台无关的套件在表里声明只跑一边，所以没有“两处各跑一遍同一件事”。重跑规则不变：不重跑失败或单个作业，要再跑就推新提交。
- **失败怎么分类。**
  - 测试失败：作业结论 `failure`，步骤摘要写出哪个套件失败。进了规则集之后，第 8 段把它当确认失败：不入队、不延长、已入队则归还合并位（`REQUIRED_CHECK_FAILED`）。
  - 环境失败之一，runner 不在线：作业一直排队，检查缺失。fail closed：PR 等着，不算失败，不归还合并位。
  - 环境失败之二，作业在检出或准入钩子处失败：结论同样是 `failure`，从失败的步骤能看出不是测试。处理办法和 Linux 侧今天一样（推一个空提交再跑）。
  - 两种都不计入常驻的熔断和发布上限：那两个只数常驻自己各段的环境类、网络类失败（`queue.mjs`、`classify.mjs`），Actions 检查不是常驻的段。
- **推送成本。** 每个 head 多一个 Windows 作业；head 配额（每 Task 24 小时 40 个）不变。Windows 侧选中的套件是 Linux 侧 `ci-suites` 的子集；实际用时在观察期记下。
- **新检查怎么接进合入门和 Owner 规则。** 只有一处：Owner 在规则集 `24182890` 里加必需检查 `ci-suites-windows`，integration 钉 App `15368`。合并位报告器、第 8 段、列车落地条件读的都是实际规则集，不写死检查名，不用改代码。“别的工作流不许用这些作业名”的门禁守卫今天还没有（`work/ci-required-tests-v1/DESIGN.md` §9 的后续项）；做它的时候把 `ci-suites-windows` 一并算上。

## 7. 上线顺序（不让 main 卡死，不留覆盖空窗）

最少三个 PR。评估过把第 2 步并进第 1 步，并不进去，硬性原因写在第 2 步下面。

1. **PR 1（本分支）。** 选择逻辑认平台、`--run-selected`、候选工作流文件（`work/ci-required-tests-v1/clued-required-tests-windows.candidate.yml`，还不是工作流）、端到端测试、静态检查与三处修复。没有新检查，main 不受影响。**本地验证的规则不动。**
2. **PR 2：让工作流生效。** 把候选文件去掉头四行，放到 `.github/workflows/clued-required-tests-windows.yml`，同一个 PR 里做完登记（在本分支上实测过，下面每一项都是测试实际要求的）：
   - `.github/actions/ci-temporary-storage/coverage.json` 加这个工作流；
   - `clued-work-admission.test.mjs` 的“用独立 Linux 准入门的工作流”名单加这个文件（门作业摘要 `9c582144…` 已登记，不变）；
   - `clued-gated-proof-profiles.json` 与 `clued-gated-proof-role-specs.json` 登记它的 Source 和角色（`compileRegisteredWorkflow`，一个 primary `ci-suites-windows`）；`clued-workflow-profile-codec.test.mjs`、`clued-scan-start-prereg.test.mjs` 还原历史目录时把它剔除，`clued-gated-proof.test.mjs` 的适用工作流名单加上它；
   - `merge-admission-four-sources.test.mjs` 的 Full 夹具（“五个原有工作流加 required-tests”）要按新的适用集合改；
   - `clued-merge-slot-ci.yml` 的 `workflow_run.workflows` 名单：它是登记过的 control Source（`clued-control-workflow-source.mjs:802`），改它的 PR 只有在 main 的目录里已有这次变更时才被准入（`clued-work-admission.mjs:789-796`、`1514-1516`，`control_Source_not_registered`）。报告器已停用（Decision `928e6638`，GitHub 上 `disabled_manually`），所以 PR 2 不改它，在 `clued-merge-slot-ci.test.mjs` 里写明这一个名字暂不在名单里；
   - reconcile、R9 登记与组件版本由自动生成器重算；
   - 都是受保护路径，需要 Owner 的 `repo.protected_change` Grant 和 Source 接受。
   - 规则集里此时**没有**这项检查，本地验证的规则仍不动。
   - 实际做的时候多出的一处：候选文件转正后，`ci-required-selection.mjs` 里指向候选文件的路径删掉，这个文件的字节被 `clued-required-applicability.mjs#REQUIRED_SELECTOR_SOURCE` 钉住，所以同一个 PR 里重钉（blob、sha256）。
   - **非必需期间它挡不挡合入（已查实）。** 不挡。现行合入路径（常驻列车、第 8 段、合并位）读的是实际规则集，规则集里没有它。读 Full 证明集合（`applicableCI`、`qualifiedCI`、`ciWorkflows`）的只有 `clued-merge-executor.mjs` 和 `clued-merge-slot-ci.mjs`，两个托管工作流都已停用（Decision `928e6638`）；Merge Admission 是候选、未接受。**如果在第 4 步之前重新启用这两个托管工作流，它们会把这项检查当成每个 PR 都要有的成员**，那时要先完成第 4 步，或先停用本工作流。
   - 常驻包不改，不出新包，两台节点不用升级。

   **为什么并不进 PR 1（硬性原因）：**
   - **新工作流必须有登记过的 Source。** `apps/clued-cloud/tests/ci-proof-profiles.test.mjs:47-49` 要求 `ciWorkflows()` 列出的每个带准入门的工作流都有登记的 Source 身份；没有就过不了 `clued-cloud-tests`。
   - **登记了就进入 Merge Admission 的 Full 证明集合。** `clued-gated-proof.mjs` 的 `applicableCI` 把登记过、没有路径过滤的工作流算作每个 PR 都适用（`clued-gated-proof.test.mjs:301-308`）；`merge-admission-four-sources.test.mjs:382-386`、`592` 的夹具写死了这个集合的大小。也就是说，工作流一登记，它的运行就成了那套证明的一员，不等规则集。
   - **而引入它的那个 PR 自己的 Windows 运行必然失败。** 作业跑的是 trusted base 上的选择文件（工作流里的 `node trusted/scripts/ci/ci-required-selection.mjs --run-selected …`），base 上的这个文件还不认识 `--run-selected`，退出码 2。两件事放进同一个 PR，这个 PR 自己的 Full 证明里就有一个注定失败的成员。先合 PR 1（入口先到 main），PR 2 的 Windows 运行才可能是绿的。
   - 另外，这也是观察的前提：PR 2 自己的那次运行就是第一次真实结果，它红了就不合。
3. **观察**（清单，逐项记结果）：
   - 两台宿主机的 Windows runner 各至少一次全绿，main 的 push 运行也绿；记下用时。
   - **Windows 作业不让路给常驻批次（待观察项）。** 它和常驻批次同时跑在同一台宿主机上。观察期内看它会不会挤占生产：常驻第 2 段转发放弃（`e0a5630d` 那一类）、批次用时变长、看门狗暂停 runner、宿主机内存或 C: 余量告警。出现任何一项，就先加有界让路（`local-verify.mjs#yieldToResident` 已有实现；先实证 `clued-runner` 账户能读 `status.json`），再进第 4 步。
   - runner 上的 job-started 钩子放行这个新工作流的作业（看实际作业日志）。
   - Windows 上的既有失败：修，或在 `SUITE_PLATFORMS` 里写明理由暂时移出；`admission-self-tests` 的已知失败清单按 Linux 写的，Windows 上不同就用 `--write-known` 补。
   - 登记进 Full 证明集合之后，Merge Admission 那一侧的实际表现（消费者已查实，见第 2 步最后两项）。

   **通过标准（全部满足才进第 4 步）：**
   - `ci-suites-windows` 在 DESK（`clued-ci-company-win-01`）和 TURING（`clued-ci-home-win-01`）上各至少一次结论为 `success` 的 PR 运行（看作业的 runner 名），其中至少一次选中了全部 Windows 套件；合入后 main 的 push 运行也是 `success`。
   - 观察期内（至少 10 个 PR head）没有一次“Linux 三项全绿而 `ci-suites-windows` 因非测试原因失败”（检出、钩子、临时目录、runner 掉线）。出现一次就先查清并修掉，重新计数。
   - 观察期内常驻侧没有新增的第 2 段转发放弃、看门狗暂停、内存或 C: 余量告警；批次用时没有明显变长。
   - 未准入的 PR 上作业名是 `ci-suites-windows-skipped`，没有以 `ci-suites-windows` 之名成功过。
   - Windows 上没有靠“已知失败”之外的办法放过的失败；`SUITE_PLATFORMS` 里每一项暂时移出都写了理由并登记了缺陷。
4. **设为必需，同时本地验证改为可选（一步）。**
   - Owner 在规则集 `24182890` 里加 `ci-suites-windows`（App `15368`）。
   - 紧接着合入 **PR 3**（文档）：把“推送前本地验证”改成可选自查，涉及 `docs/maintenance/independent-ci.md`、`docs/maintenance/README.md`、ADR 0003、runbook §7、`scripts/ci/local-verify.mjs` 文件头。PR 3 只在规则集改完之后开，它自己就要过 `ci-suites-windows`；规则集没改，它不合入。顺序固定为“先必需，后可选”，任何时刻 Windows 都至少有一道把关。
5. **回退。** 任何时候：Owner 从规则集拿掉这项检查，再禁用这个工作流；同时回退 PR 3（本地验证重新成为规则）。不影响 Linux 三项，不动节点。

## 8. 本地验证

- 第 4 步之前：现行规则不变，推送前照旧跑 `local-verify.mjs`（默认模式跑 Windows）。
- 第 4 步之后：它不再是推送的前提，是可选自查；把关的是两个平台的必需检查。
- 工具调用 `selectSuites(check, files)` 时不带平台，选出的是两边的并集；CI 在某一边跑什么，只看 `SUITE_PLATFORMS`。

## 9. 手拼 `file://` 的静态检查

- 规则（`main-entry-realpath.test.mjs#buildsFileUrlByHand`）：源码里不许出现带引号的 `file://` 前缀后面直接收尾或接模板表达式（`'file://' + x`、`` `file:///${x}` ``）。URL 用 `pathToFileURL` 生成；判断入口用 `import.meta.main`，装机的旧 Node 可能不支持的地方用 `realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)`（`notifier-main.mjs` 已有的写法，链接后面也成立）。
- 它在 `clued-cloud-tests` 里对每个改动都跑（`apps/clued-cloud/tests/local-dev-tools.test.mjs` 引入这个文件），不用另加套件。
- 修掉的三处：`src/service-main.mjs`、`src/companion-main.mjs`（Windows 写法，Linux 上不成立）、`work/twentyfirst-forward/derive-getter-module.mjs`（POSIX 写法，Windows 上不成立）。三个文件同时从 `main-entry-legacy.json` 里删掉。
- 一处按**确切字节**放行（`FILE_URL_BY_HAND_PINNED`：路径加 sha256）。文件只要有任何改动，放行就失效，必须连同这个写法一起改掉；这个路径上别的内容永远不被放行：
  - `scripts/phase2-qualification/RuntimeMaterialPreparation/prepare.mjs`：已接受的交接证据，字节被 `config/clued-handover-external-acceptance.json` 钉住，改它要重新走接受。
  - （`tools/build-package.mjs` 已由 #1092 的 `3e2da768` 修好并合入 main，不需要放行。）

## 10. 残余

- 第 4 步之前，Windows 侧的 CI 检查还不是必需的；这段时间推送前的本地验证仍是规则，由它兜底。
- `reinstall-python` 在 Windows 上的 10 个失败没有修（§5）。
- Windows runner 整池不在线时，`ci-suites-windows` 缺失，所有 PR 等着。和 Linux 池不在线时的现状一样；回退办法见 §7 第 5 项。
