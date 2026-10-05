# Work Claim Admission v0.1：多 Agent 执行准入与费用保护机制候选

状态：**部分实施。** 第 1–6 步已在生产生效，强制开启。第 7 步实测已完成；独立评审 HOLD_FAIL 的修复已合入；2026-10-03 的复审、2026-10-04 的复审 2 至复审 6（Task `869d2db7`）与 2026-10-05 的复审 7（Task `737699cd`）均为 HOLD_FAIL，修复见下（Owner Decisions `38ddb8cf`、`b0c53143`、`b43f8b8a`），待复审 8。方向由 Owner 接受（Decision `78ca0c07`），不是架构接受。
日期：2026-10-01（状态更新 2026-10-05）
来源：Owner 上传的《Clued 多 Agent 执行协调与费用保护：讨论纪要与既有机制对账》（2026-10-01）的重新评估，以及对纪要第九节源码与合同的只读对账（固定在 commit `f7ba6ff312aa0e90095db1e28f5937920f30de3a`）。
通用化后续：任意资源、一个门卫多个门口、领取模式（独占/拆分/多份）的设计候选见 [GenericWorkClaim.v0.1.md](GenericWorkClaim.v0.1.md)（Task `52739939`）。
治理：起草时受 Global Decision `93eb4e76` 的暂停约束（只读评估与设计豁免）。该约束已由 Decision `78ca0c07`（2026-10-01）取代。各步实施由 Owner 逐步授权。本文件本身不授予实施、合并、部署或权限变更。

### 当前状态（2026-10-02，对照 main `f844d6a`）

- **已上线**：
  - `work_claims_v1` 与 transport、admission hardening、会话上限迁移已应用 clued-prod。
  - Worker 五个认领工具与 resume 的 `active_work_claims` 已发布。
  - `clued-work-admission` 是 `main` 的必需检查，`CLUED_WORK_ADMISSION_ENFORCE=true`。
  - 六个自托管重任务 workflow 有 `admission-gate`，三个重任务的手动触发须经准入。
  - Claude Code 钩子已合入。
  - 各项实现细节见 §4.3、§4.5、§4.6 的「实现」条目。
- **第 7 步**：
  - 验收矩阵实测：PR #467。
  - 独立评审 HOLD_FAIL。修复已合入：PR #472、#479、#480，另有 PR #475、#477。
  - 复审（2026-10-03，Task `869d2db7`，对照 main `cd84acd2`）：fresh-context 只读评审，HOLD_FAIL。
    - 已修好：BLOCKER-1（准入跑 PR 代码）、MAJOR-4（glob 相交）。合并这一关成立：base 代码、environment 持有 token、App 限定来源的必需检查。
    - 新发现（MAJOR）：N1 多份模式的采纳可伪造；N2 任何 Agent 可把别人的认领绑到假 PR、或撑满其 CI 额度；N3 自托管 CI 花费闸可绕过（改过的分支手动触发、旧分支 push、发往非 main 的 PR 冒充准入），且文档夸大；N4 workflow 守卫的 YAML 读法可被引号、flow 写法、4 空格缩进与非字面标签绕过。另有 MINOR N5–N8。
    - 修复（迁移 `20261003200000_work_claims_binding_roles.sql`、`scripts/ci/clued-work-admission.mjs`、`scripts/runner/`）：
      - N1/N2/N5：Owner 在 `/bindings` 页面（Native 两步）标出 CI 准入 Binding 与发布门口 Binding；标出后，带 `pr_ref` 或 `ci_dispatch` 的 verify、合并后采纳只认 CI 准入 Binding（其他返回 `admission_binding_required`），发布门口只认发布门口 Binding。未标出时保持原行为。
      - N3：去掉旧分支的 push 触发；PR 内的 gate 只认本 PR 的准入运行；手动触发的准入记下所核验的提交并计入 CI 额度，重任务只在同一提交上放行。
      - N3 硬拦截：自托管 runner 的开工前检查（`scripts/runner/README.md`，Decision `b0c53143`）。装在 runner 机器上、不在仓库里：改了任何 workflow 的运行要有 base 代码的准入结果，非 main 的 push、发往其他分支的 PR、改了 workflow 的手动触发一律拒绝（复审 7 m1 起，`pull_request_target` 也按 PR 的 base 判断）。由 Owner 在每台 runner 上安装、并按 README 第 6 步加固后生效（复审 7 MAJOR-4）。
      - N4：workflow 必须是守卫能读的写法（否则拒绝）；只有单个字面 `ubuntu-*`/`windows-*`/`macos-*` 标签才算托管 runner；已有的不设闸检查不能新增自托管 job。
      - N6：migrate 的授权资源写明迁移文件；整段事务用 `psql -c` 交给服务器，迁移文件里的 psql 元命令不会执行；授权在凭据检查之后才消费。
      - N7：合并后的采纳任务用单独的并发组。N8：被 workflow 守卫拒绝的 PR 只做只读核验，不计入 CI 额度。
    - 未修：PR 正文可以写别的 Agent 的认领 ID（仓库侧不知道 PR 由谁打开）；按 Task 计量，Task 越多额度越多。
  - 复审 2（2026-10-04，Task `869d2db7`，对照 main `4f770dcd`）：fresh-context 只读评审，HOLD_FAIL。N1、N5（专用 Binding 有效期间）、N6、N7、N8 确认已修；N2、N3、N4 部分修复。
    - 新发现：
      - A（MAJOR）专用 Binding 撤销或过期后，角色检查回到「谁都能做」，N1、N2、N5 重新打开；
      - B（MAJOR）runner 检查用 `main...sha` 比较，指向 main 旧提交（加闸之前）的分支看不出差别，可以手动触发无闸的自托管任务；
      - N3c：gate 与 runner 检查都靠运行的 `pull_requests` 字段认 PR，但 GitHub 说明该字段列出的是同 head 的所有打开 PR，不是触发者；
      - N4 剩余：单独的 `\r`（以及 U+0085、U+2028）在 YAML 里是换行，守卫看不见，可以藏一个自托管 job；
      - C（MINOR）不加闸的自托管 workflow 没有超时，文档里加闸列表写错；D（MINOR）合同 §1.7 一句话拼接错。
    - 修复（迁移 `20261004050000_binding_roles_fail_closed.sql`、`scripts/ci/clued-work-admission.mjs`、`scripts/runner/`、`/bindings` 页面）：
      - A：某个用途只要 Owner 标过、且没在 `/bindings` 上取消，就一直锁着，持有它的 Binding 撤销或过期也一样。那时谁都做不了这件事，直到 Owner 给新的 Binding 标上，或取消。`/bindings` 列出已失效但仍持有用途的 Binding（只能取消）。从没标过的用途保持原行为。
      - N4：workflow 文件里出现单独的 `\r`、U+0085、U+2028、U+2029 或其他控制字符，一律拒绝（`workflow_not_canonical:line_break`）。
      - N3c：gate 与 runner 检查改认 clued-admission App 在该 head 上的 `clued-admission-verified` check（最新一条为准）。App 的私钥只在 `clued-admission` environment 里，只有 main 上的准入运行能发；不再看工作流运行的 `pull_requests`。gate 需要 `checks: read`，分两步完成：PR #532 先在 `GATE_JOB_SHA256` 中加入新摘要，gate 读不到 check 时暂按旧办法；第二步 PR 给 8 个有闸 workflow（原写 7 个，复审 7 n1 更正）的 gate job 加上 `checks: read`，并去掉旧摘要与旧办法。现在 gate 读不到 check（403）即报错，强制模式下不放行。
      - B：runner 检查对手动触发要求该提交的 `.github/workflows` 与 main 完全一致（逐个文件对象 id），否则先把 main 合进分支。PR 仍按 merge base 比较（PR 的 workflow 来自 merge ref，即 main 加上 PR 的改动）。
      - C：不加闸的自托管 workflow（`model-program-m1-*`、`mps03-native-agent`、`multitrack-governance-projection`、`node-profile-policy`、`runner-budget-policy`、`gitleaks`）每个 job 设 20 分钟超时（gitleaks 25 分钟）。`model-program-m0.yml` 不改：它的哈希登记在冻结的 `development/contracts/model-program/m0/SHA256SUMS.json` 里，job 仍用 GitHub 默认的 6 小时上限。D：合同 v23 改正该句。
    - 仍未修，写明靠自觉：
      - PR 正文可以写别的 Agent 的认领 ID；手动触发 `clued-work-admission-dispatch.yml` 时也可以填别的 Agent 的 `claim_id`，计入其 Task 的 CI 额度（仓库侧不知道是谁触发的）。两者都受每 Task 每天 40 个 head 的上限约束。
      - 不加闸的自托管检查会跑 PR 的代码，未被认领覆盖的 PR 也会跑，每个 job 最多 20–25 分钟（`model-program-m0` 没有超时，见上）；`clued-integration-runtime-nightly.yml` 任何人都能在 main 上手动触发，跑的是 main 的代码，不计入额度。
  - 复审 3（2026-10-04，Task `869d2db7`，对照 main `d0100ff4`）：fresh-context 只读评审，HOLD_FAIL。A、B（有闸 workflow）、D 与此前大部分发现确认已修；数据库一侧与合并这一关成立。
    - 新发现：
      - N-R1（MAJOR，#533 引入）：gate 与 runner 检查认该 head 上最新的 App check，而 check 在准入运行结束时才发，在那之前同 head 上更早的成功 check 就是「最新」。强推回以前准入过的提交、重开已释放认领的 PR、另开同 head 的 PR、重跑重任务都会被放行，且不计入额度；
      - N-R2（MAJOR）：runner 检查放行任何分支上「workflow 与 main 一致」的手动触发，但 `clued-integration-runtime-nightly`、`mps03-native-agent` 没有闸，会用分支的代码跑自托管机，不需要认领；
      - N-R3（MAJOR）：重跑绕过 gate 与 runner 检查。重跑沿用该次运行自己的 workflow 文件（加闸之前的运行没有闸），「只重跑失败的 job」沿用 gate 上次的放行结果；
      - N-R4（MAJOR）：准入 workflow 检出事件里的 base 提交，重跑旧的准入运行就会用当时的旧检查代码（例如 #532 之前看不见单独 `\r` 的守卫），拿到现在的 secret，发出成功的 App check；
      - N-R5（MINOR）守卫没管已有托管 job 改到自托管 runner、自托管 job 去掉超时；N-R6（MINOR）准入出错时不发失败 check，更早的成功 check 仍是最新；N-R7（MINOR）文档缺漏（trivy 没有超时、重跑、草稿 PR、N-R2）。
    - 修复（Owner 选择按最短路径全修）：
      - N-R1：gate 与 runner 检查只认在本次运行创建之后发出的 App check（看 check 的发出时间，不看 id）。
      - N-R2：runner 检查只允许在其他分支上手动触发三个有触发闸的 workflow（`DISPATCH_GATED_WORKFLOWS`）；其余可手动触发的 workflow 只能在 main 上跑。
      - N-R3：runner 检查拒绝 PR 与分支手动触发运行的重跑（运行次数 2 及以上，包括「只重跑失败的 job」）；gate 也拒绝重跑（`RERUN_REFUSED`）。要重跑就推一个新提交。main 自己的运行可以重跑。
      - N-R4：准入 workflow 改为检出 base 分支的当前提交（`base.ref`），重跑也跑现在的检查代码。App 私钥与 Clued token 的 secret 改名为 `CLUED_ADMISSION_APP_KEY`、`CLUED_ADMISSION_CLUED_TOKEN`（Owner 在 `clued-admission` environment 中新建，合并后删掉旧名），旧的运行定义重跑时拿不到任何一个，什么也发不出。
      - N-R5：守卫拒绝不加闸 workflow 中已有托管 job 改到自托管 runner，以及自托管 job 去掉或调高 `timeout-minutes`。trivy 的自托管 job 设 25 分钟超时。
      - N-R6：准入步骤出错、没报出 head 时，失败 check 发在事件的 head 上。
      - N-R7：`scripts/runner/README.md` 写明重跑、草稿 PR、只能在 main 上跑的 workflow。
    - 仍靠自觉或未覆盖：每小时的复核跳过草稿 PR；runner 检查装上之前，重跑与手动触发只受 gate 约束（「只重跑失败的 job」不经过 gate）。
  - 复审 4（2026-10-04，Task `869d2db7`，对照 main `73895d93`）：fresh-context 只读评审，HOLD_FAIL。此前各轮的 CI 花费问题（含复审 3 的 N-R1 至 N-R7）在代码里都已修好；合并这一关成立（ruleset 要求 App 5164952 的 check，无豁免名单）。
    - 新发现：
      - M1（MAJOR，复审 2 A 的回归）：`/oauth/connections` 撤销旧 Binding（`clued_headless_binding_revoke_v1`，迁移 `20261004170000`，生产已执行）会把它持有的角色一起结束；该角色没有有效持有者后，角色检查回到「从没标过」，谁都能做。
      - M2（MAJOR）：重跑发布门口上线之前的发布运行，用的是当时没有授权步骤的 workflow，又能读到仓库级的 `CLUED_CLOUDFLARE_DEPLOY_TOKEN` 与 `CLUED_ATTESTATION_DATABASE_URL`，可以不经 Owner 授权把生产回滚到旧提交。
      - m1–m6（MINOR）：App check 不带 PR 身份，同 head 的另一个 PR 可借用；check 早于重任务运行创建时，合法运行被拒；守卫没管不加闸自托管 job 的 `strategy`；两个有闸 workflow 的自托管 job 没有超时；几处文档；dispatch 与 reverify 检出运行自己的提交。
    - 修复：
      - M1：迁移 `20261004220000_legacy_revoke_keeps_roles.sql`，撤销旧 Binding 不再结束角色，与 `manage_v12` 撤销一致：角色锁在已撤销的 Binding 上，直到 Owner 在 `/bindings` 给有效的 Binding 标上或取消。结果与回执写 `roles_kept`。连接页提示改为「撤销后这些角色仍然锁定」。
      - M2：两个 secret 改名为 `CLUED_CLOUDFLARE_DEPLOY_TOKEN_V2`、`CLUED_ATTESTATION_DATABASE_URL_V2`（发布、存储与核验 workflow 都改用新名）。Owner 合并前新建，合并后删除旧名；旧运行重跑时拿不到部署凭据。
      - m1/m2：准入 App check 的 `external_id` 写成 `pr:<编号>:run:<准入运行 id>`；gate 与 runner 检查只认写着本 PR 的 check，并接受本次运行创建前两分钟之内发出的（同一次推送触发的准入常常先到）。
      - m3：守卫拒绝不加闸 workflow 中自托管 job 新增或改动 `strategy`。m4：`public-mcp-behavior`、`public-mcp-protocol` 的自托管 job 设 25 分钟超时。
      - m5：合同 v27 §1.7 写明不要重跑 PR 或分支手动触发的运行，要重试就推新提交；runner README 写准确「哪条 check 算数」。
      - m6：dispatch 与 reverify 检出默认分支的当前提交。
  - 复审 5（2026-10-04，Task `869d2db7`，对照 main `1f1be647`）：fresh-context 只读评审，HOLD_FAIL。M1、m1–m6 已修好；生产迁移 `20261004220000`（md5 `597fd91d…`）与 v27 已核对；此前各轮没有回归。
    - 新发现：
      - N1（MAJOR，M2 的剩余部分）：`_V2` 两个 secret 是仓库级的（存储与核验三个 workflow 不声明 environment 也读它们），任何能推分支的 Agent 都可以加一个 `on: push` 的托管 runner workflow，直接用部署 token 部署生产，不经 Owner 授权；合并闸、准入、runner 检查都不经过。
      - n1（MINOR，N-R1 的窄回归）：两分钟的发出时间窗口分不清事件：PR 在窗口内关闭再重开时，前一个事件的成功 check 可放行后一个事件的重任务。
      - n2（MINOR）：合同 v27 §1.7 说 gate 与 runner 检查拒绝重跑（含「只重跑失败的 job」），但 runner 检查尚未安装，「只重跑失败的 job」也不经过 gate。
    - 修复（Owner 选择 N1+n1+n2 一起修）：
      - N1：两个 `_V2` secret 只放在 `clued-release` environment（只限 main）。`clued-storage-executor-window`、`clued-storage-read-config`、`clued-currentness-post-deploy-attestation` 的 job 都声明 `environment: clued-release`。测试检查：凡读这两个 secret 的 job 都声明该 environment 且只在 main 上跑，job 之外不出现它们，也没有按计算名读 secret 或整体转交。Owner 合并前在 `clued-release` 中新建两个值，合并后删除仓库级的 `_V2`，并作废旧 Cloudflare token。
      - n1：gate 与 runner 检查改为绑定本事件的准入运行：同一事件的运行一起创建（实测相差一秒内），本事件的准入运行就是该 head 上本次运行创建前 15 秒以来最新的 main 准入运行（`pull_request_target`），写着别的 PR 的不算；只有它的 check 算数，它还没发出 check 时就等。运行列表只用来找运行，判定仍只看 App check。
      - n2：合同 v28 §1.7 写明 gate 只拒绝「全部重跑」，「只重跑失败的 job」只有装了 runner 检查的自托管 runner 能拦，其余靠 Agent 遵守。
    - 仍靠自觉或未覆盖：runner 检查未安装；Agent 仍有生产 Supabase 写权限（OwnerCredential §9）；PR 正文可写别的 Agent 的认领；旧的数据库密码是否被 `_V2` 复用未知，Owner 选择暂不轮换。
  - 复审 6（2026-10-04，Task `869d2db7`，对照 PR #547 head `fd7dfd97`）：N1、n1、n2 已修好，#547 本身没有新问题；另发现一个早已存在的 BLOCKER：
    - B1：准入 workflow 对任何目标分支的 PR 都运行，并检出 PR 的目标分支（`base.ref`）上的脚本，同时拿着 App 私钥与 Clued token。GitHub 2025-12-08 起 `pull_request_target` 一律以默认分支运行，main 限定的 `clued-admission` environment 也会给出 secret。Agent 推一个分支 X、改掉 X 上的准入脚本、开一个合并到 X 的 PR，就能拿走私钥或给任何 PR 伪造准入 check。
    - 修复（Owner：发现问题原地修、原地审，并入 #547）：准入与 adopt 两个 job 只对目标是默认分支的 PR 运行，并且固定检出默认分支；测试检查两者。合并到其他分支的 PR 没有准入 check，gate 与 runner 检查照常拒绝。
  - 复审 7（2026-10-05，Task `737699cd`，对照 main `8b418e5`）：fresh-context 只读评审，HOLD_FAIL（BLOCKER 0 / MAJOR 4 / MINOR 7 / NIT 4，Note `c6321ae8`）。B1、`_V2` 隔离、n1/m1、N-R2/N-R3、角色锁、认领恰一获胜与幂等、glob 相交、CI 计量确认成立。
    - 新发现：
      - MAJOR-1：每小时复核按 head 取最新一条准入运行，不分 PR。同 head 开一个发往其他分支的 PR（准入 job 跳过）或取消一次运行，认领失效后原 PR 的绿色 App check 一直有效。
      - MAJOR-2：守卫用 `previous_filename` 取 base，从非 workflow 文件改名进 `.github/workflows/` 的文件被当成已有的不设闸 workflow。
      - MAJOR-3：ruleset 0 审批，Agent 能合并自己的 PR，「main 的代码可信」不成立：合并后可去掉发布门口的授权步骤、读 `clued-release` / `clued-admission` 的 secret、改写准入，或给不设闸的自托管 workflow 加 `schedule` / `push`。
      - MAJOR-4：runner 检查由 runner 目录的 `.env` 启用，跑 PR 代码的 job 与它同一账户，能改写它。
      - MINOR：m1 `memory-publication-gate` 对发往任意分支的 PR 在自托管机上跑该分支的脚本；m2 head 与文件列表不是同一时刻读取；m3 续期「带进展」只是字符串去重（§4.4 夸大）；m4 同一 Binding 的会话可以释放、续期、出示彼此的认领（GenericWorkClaim §4.1 不符）；m5 仓库级 secret 与托管分钟不受保护且未写明；m6 多份采纳失败时 job 仍成功；m7 Agent 用 Owner 的 GitHub 身份（仓库管理员）未写明。NIT：n1「7 个有闸」实为 8 个；n2 注释解析不要求 `#` 前有空白；n3 PreToolUse 不匹配 `merge_pull_request` 等；n4 同 head 另一 PR 的失败 check 会挡住原 PR。
      - 已知项影响被低估：PR 正文写别人的认领 ID 不只计入对方额度（见 §4.7）。
    - 修复（Owner Decision `b43f8b8a`：全修后派复审 8；Task `c7b721ee`）：
      - MAJOR-1：复核改读 App check（它写明 PR），只看发往默认分支的 PR，以该 head 上最新的 App check 是否成功为准；不再准入时由 App 直接发一条失败 check（`pr:<n>:run:<复核运行 id>`）挡住合并，无 App 私钥时重跑本 PR 自己的准入运行，两者都不行算错误（复核 job 失败）。复核 workflow 加 `checks: read` 与 App 私钥。
      - MAJOR-2：只有改名前也是 workflow 文件时才取 base；从别处改名进来或复制的按新增 workflow 检查。
      - MAJOR-3：新增「Owner 复核」（§4.6「实现（复审 7）」）：改动保护路径、声明 environment 的 workflow（改动或删除）、新增 secret 引用、改动含自托管 job 的 workflow 的触发器，准入要求该 head 提交上的 Owner Grant（`repo.protected_change`，迁移 `20261005120000_owner_grants_admission_door.sql`）。Owner 设 `CLUED_OWNER_REVIEW_ENFORCE=true` 后强制，之前只提示。覆盖不到的写进 §4.7。
      - MAJOR-4：`scripts/runner/README.md` 第 6 步：临时（ephemeral）runner，或把 hook 设置放到服务账户写不了的地方（systemd drop-in / 服务注册表）、runner 目录除 `_work`、`_diag` 外只读、`--disableupdate`、`ptrace_scope≥1`。不加固时 runner 检查不是硬保证。
      - m1：`memory-publication-gate` 的自托管 job 只对发往默认分支的 PR 运行，两个 job 都从默认分支取校验脚本；runner 检查对 `pull_request_target` 读事件中 PR 的 base，不是默认分支就拒绝。
      - m2：判定为 ADMITTED 后再读一次 PR，head 变了就报错（不发成功）。
      - m5：`clued-release-tags` 的 job 进 `clued-release` environment，`CLUED_RELEASE_TAG_TOKEN` 可由 Owner 移进该 environment。其余写进 §4.7。
      - m6：采纳返回 `adopted:false` 且原因不是「不是份」（`no_copy_for_pr`、`not_a_copy`）时 job 失败。
      - n2：`runs-on` 与 `timeout-minutes` 的注释需要 `#` 前有空白。
      - m3、m4、m7、n1、n4 与已知项：文档更正（§4.4、§4.7、GenericWorkClaim §4.1、§8、§10.6）。
      - n3 未改：钩子属合规层（L3），改动在 `scripts/hooks/`，留作后续。
    - Owner 需要做的设置（合并后）：应用迁移 `20261005120000`（经发布 workflow 的 `migrate`，需授权）；Worker 无需发布；把 `CLUED_RELEASE_TAG_TOKEN` 移进 `clued-release` environment；试跑一次 Owner 复核后设 `CLUED_OWNER_REVIEW_ENFORCE=true`；在各 runner 上做 README 第 6 步。
- **尚缺或与本文设计不符**（各条在对应小节标注）：
  - 每认领 CI 分钟预算与 finalize：改为次数上限，不做（§4.5，Owner Decision `a264ea02`）。
  - 备份恢复后 `max(fence)` 会回退，靠恢复后的手工步骤补救（§4.4、§6，Owner Decision `2b23eb0c`）。
  - 同名 check 伪造与 PR 删除 `needs: admission-gate`（§4.6）。
  - 判定只在检查运行时成立，合并时不实时重验（§5）。
- **Owner 设置（2026-10-02）**：
  - 已完成（Owner 自述）：`clued-admission` environment 限 `main`、不设审批人；新只读 token 放入 environment secret，删除仓库 secret，撤销旧 token。
  - 已验证：`clued-work-admission-dispatch` run `37003236812`（main `e2a1c06`）在该 environment 中拿到 token，Clued 以强制模式判 ADMITTED。部署分支限制与仓库 secret 删除无法从 Agent 侧读取，未独立验证。
  - 防同名 check（Owner Decision `37e01bb1`）：仓库侧已就绪（`clued-admission-verified`，§4.6）；Owner 已建 `clued-admission` GitHub App（仅 Checks 读写，只装在本仓库；2026-10-02 删除重建一次，旧私钥随旧 App 作废）并把 App ID 与私钥放进 `clued-admission` environment；`clued-admission-verified` 已在 main ruleset 设为必需检查，来源限定为该 App。

---

## 0. 一句话结论

纪要把问题定义对了，但把修复方向放在了一个不存在的执行点上。它要求"成本准入先于派发"，而派发模型调用的是 Claude Code、Codex 这些第三方 Host，Clued 在它们之前没有任何可控入口。可控的只有三处：Clued 自己的数据库、本仓库的 CI workflow、`main` 的 ruleset。有效机制必须把硬保证放在这三处，把"派发前准入"降级为合规路径，并如实标出不受保护的部分。

---

## 1. 对纪要的重新评估

### 1.1 同意的部分

- 根因定义正确：已有协调语义没有在普通开发的成本派发、受控写入、最终整合三条路径上形成不可绕过的证据链；人的遗漏是触发条件，不是修复方案。
- "已实现 / 历史已运行 / 候选 / 未验证" 的分层正确。全库只读扫描确认：仓库里**没有**任何面向普通工作的通用 claim、lease、admission 或预算预留接到 MCP 工具、Worker 路由、CI 或 hook 上。所有已实现的租约都绑定单一子系统（见第 2 节表）。
- 第六节"检测不等于阻止"、第七节"故意不遵守也必须失败"的验收立场正确。

### 1.2 不同意或需要修正的部分

| 纪要位置 | 问题 | 修正 |
| --- | --- | --- |
| §5.1 成本准入先于派发 | 预设存在一个"可控的调度入口"在模型调用、子任务、下载、构建之前做检查。本次三份 PR 分别来自两个 Claude Code web 会话和一个 Codex 桌面会话，它们各自派发自己的模型调用与本地构建，Clued 在那之前没有任何执行点。纪要自己在 §5.1 末尾承认了这条边界，却仍把它列为第一候选方向。 | 把"派发前准入"拆成两层：Host 内的本地开销（模型 token、本地 npm install／build／test）只能走**合规路径**；跨 Host 共享的开销（自托管 CI runner、CI 内 Supabase 栈、合并到 main）走**硬门禁**。 |
| §5.2 写能力只交给受控执行者 | 对 GitHub 分支写入要求"可信资格门禁"。分支本身是廉价的，Agent 用 Owner 身份推分支无法也无需阻止。 | 分支写入不设门禁；门禁设在 CI 重任务入口和 `main` ruleset 的 required check。 |
| §5.3 继承 WorkLease 候选 §12 的"单 active broker + 本机 SQLite journal" | 那是为单机 DCP 设计的。本次故障是三台机器、三个 Host 并发，单机 SQLite 不是 broker。 | broker 就是 Supabase Postgres。Projection Refresh 已经在它上面跑着 `FOR UPDATE SKIP LOCKED` + lease_id + 30 秒期限 + 有界重试 + watchdog，并有生产运行记录。复用这套，不另起 broker。 |
| §二 事实边界 | 只记录 #443、#444。#445（04:20Z，另一独立 Claude Code 会话）未被吸收，Task 14a81caa v9 的 overlap_check 当时已列出它。 | 事实见 Note `46f46fed`；整合顺序见 Decision `8b22f847`。 |
| §四 根因只说"没有证据链" | 没有指出三个会话是被**同一个信号**（Trivy 在所有 PR 上变红）触发的。这意味着去重的关键不是标题或文件，而是**触发源**：GHSA 编号、失败的 check 名 + base SHA。 | 冲突判定加入 `trigger_refs`（第 4.3 节）。 |
| §四 威胁模型 | 把"故意绕过"与"遗漏"并列，导致验收矩阵偏向对抗场景。实际所有 Host 都由同一 Owner 驱动、用同一 GitHub 身份；真实失败模式是**诚实并发 + 延迟发现**，不是恶意。 | 设计目标按"诚实并发"优化（早发现、低摩擦），硬门禁只在共享资源处防"忘了"和"旧会话继续推"。对抗性保证只在 Clued DB 与 `main` ruleset 两处宣称。 |
| §三 "#444 曾依赖 v4 合同" | 定性为"入口一致性问题"但没有给出机制。Worker 下发的 `/clued-agent.md` 落后仓库 v6 是部署滞后。 | `clued_session_resume` 返回 `contract_version`；Skill 与 hook 比对本地合同版本，不一致时拒绝开工（合规路径）。 |

### 1.3 纪要遗漏的事实

- Storage N4（`20260930200000_storage_read_budget_n4.sql`）已经实现了 admit → reserve → finalize 的每 Binding 滚动小时预算，并以 advisory lock 串行化。这正是纪要 §5.1 要的"同一原子边界预留额度"，只是绑在 Storage 读上。可直接复用其模式。
- `kernel/policy/approval-lease.mjs` 的 reserve → issue → consume 带 fencing_token 与时间窗口，`external-invocation-ledger.mjs` 有 lease 与 fence 校验。它们只被 `evals/kernel-next/*` 引用，没有任何 Worker、迁移或 hook 使用。纪要说"内存参考实现"是对的，但没说清它们的 API 形状可以直接作为 claim RPC 的合同。
- Claude Code 支持 PreToolUse hook，仓库现在只注册了 Stop hook。这是本仓库内 Claude Code 会话唯一能在**开销发生前**拦截的点。
- 2026-10-01 根因审计还观察到：服务端合同已是 v6，但部分客户端暴露的工具参数仍是旧版，新读取方式需走替代路径。这与 #444 用到 v4 合同是同一类问题：版本一致性要在**真实客户端**验收，不能只看服务端自报。`contract_version` 比对（第 4.6 节 L2）只覆盖合同文本，不覆盖工具 schema；工具 schema 漂移需要另一条 bootstrap 侧校验，本设计不展开。

---

## 2. 现状对账表（固定在 f7ba6ff）

| 机制 | 已实现到哪一步 | 作用域 | 可达性 | 能否复用于普通工作 |
| --- | --- | --- | --- | --- |
| Projection Refresh claim／lease／watchdog（`20260923213000/213100/213200`） | 生产：`FOR UPDATE SKIP LOCKED`、lease_id、30 秒期限、max_attempts、过期转 RETRYABLE_FAILURE、apply 侧校验 lease_id + revision + digest | 仅 `global.priority_frontier`、`global.__aggregate__`；专用 Builder Binding | 仅 Worker cron，无 MCP／路由 | **是**：SQL 模式逐字可搬，换成 work_claims 表 |
| Storage N4 读预算（admit／reserve／finalize） | 生产 | 仅 storage 内容读 | MCP `clued_storage_read` | **是**：预算模式 |
| Storage job 与 root fence（`pg_advisory_xact_lock`） | 生产 | 仅 Resource Center 变更 | MCP `clued_storage_submit` | 部分：advisory lock 模式 |
| Context v2 稳定 execution_intent（`20260922143312`） | 生产：同 owner + intent 唯一 Task，身份不可变，在 `clued_record_mutate` 写 Task 时强制 | 所有 Task | MCP `clued_record_mutate` | **是**：claim 必须绑定已存在的 Task id，复用其身份 |
| Currentness admission 用户级 advisory lock（`20260922092932`） | 生产 | session resume／reconcile／checkpoint | MCP | 是：claim 事务复用同一用户锁，避免与 checkpoint 交叉 |
| Kernel Attempt FSM、approval-lease、external-invocation-ledger、durable outbox | 内存实现 + eval 测试；`execution.profile.json` maturity 0.x-experimental、`runtime_selected=false` | 无运行时消费者 | 无 | 作为 RPC 合同形状复用；不作为运行时 |
| Git Connector Write Contract v0.1 + `main` ruleset | 生产：PR 必须、required `gitleaks` + `trivy`、禁强推、bypass 为空 | `main` | GitHub 强制 | **是**：加一个 required check |
| capture guard Stop hook（`scripts/hooks/clued_capture_guard.py`） | 生产：事后检查、每项一次、`CLUED_CAPTURE_GUARD=off` 可关 | 本仓库 Claude Code 会话 | Stop 事件 | 否（事后）；但同一机制可加 PreToolUse |
| WorkLease 候选 v0.1.4 §4.2／§12 | 文档 | — | — | 字段定义可用；broker 选择不用 |
| MCP 工具目录（`worker/continuity.ts:1115-1415`） | 生产 | — | — | 现无任何 claim／lease／admit 工具 |

---

## 3. 可控边界与保证分层

把每个开销和写入点按"谁能物理拦住它"分层。这张表是本设计的诚实边界，任何实施完成声明都不得越过它。

| 层 | 入口 | 谁强制 | 不依赖 Agent 自觉？ | 本设计给的保证 |
| --- | --- | --- | --- | --- |
| L0 | `main` 合并 | GitHub ruleset required check `clued-work-admission` 与 App check `clued-admission-verified` | **是**（判定时） | 没有有效 claim 覆盖该 PR 的 head、base、变更文件集，就不能合并。判定在检查运行时成立，之后每小时复核一次（复审 7 MAJOR-1 起按 PR 复核）。PR 正文可以写别人的认领（§4.7）。改动保护路径等的 PR 还需该提交上的 Owner Grant（§4.6，开启 `CLUED_OWNER_REVIEW_ENFORCE` 后） |
| L0 | 自托管 CI 重任务（加闸的 8 个：Information Flow E2E、Supabase migration/pgTAP（g4-database）、connection authorization 与 isolated-candidate、node22-install、public-mcp behavior／protocol、clued-components、design-refs） | workflow 首个 job `admission-gate`（GitHub 托管 runner，秒级）；runner 机器上的开工前检查（`scripts/runner/`，Owner 安装后） | **装上 runner 检查并按其 README 第 6 步加固后是**（复审 7 MAJOR-4：不加固时，跑 PR 代码的 job 能关掉它）；只靠 `admission-gate` 时否：在改过 workflow 的分支上手动触发或 push 可以跳过它（复审 N3） | 未被 claim 覆盖的 PR 不跑加闸的重任务；改了 workflow 的 PR 要有 clued-admission App 的准入 check；非 main 的 push、发往其他分支的 PR、workflow 与 main 不一致的手动触发在开工前被拒。不加闸的自托管短检查（`model-program-*`、`mps03-native-agent`、`multitrack-governance-projection`、`node-profile-policy`、`runner-budget-policy`、`gitleaks`、`trivy` 等）照常跑 PR 代码，有超时上限；`memory-publication-gate`（只对发往 main 的 PR）与 `public-mcp-gate-receipt`（`workflow_run`，main 的代码）每个 PR 事件跑一次，不需认领 |
| L1 | Clued Canonical 与 claim 表 | Postgres 事务 + CAS + lease | **是** | 同一 write_set／trigger_ref／intent 只有一个有效 claim；过期、fence 不符的写被拒 |
| L2 | Agent 开工前 | agent-contract §1 新增步骤；`clued_session_resume` 返回冲突 claim | 否 | 合规 Agent 在**第一次 Clued 调用**就看到冲突并停下，成本止于一次 resume |
| L3 | Claude Code 本地 `git push`、`gh pr create`、`npm install`／`build`／`test` | PreToolUse hook（仓库 `.claude/settings.json`） | 否（可关、可删、只对本仓库 Claude Code） | 没有 `CLUED_WORK_CLAIM` 环境或 claim 文件时阻止这些命令一次 |
| 无 | Host 在第一次 Clued 调用前的模型 token；Codex／ChatGPT 等无 hook Host 的本地开销；任何不调用 Clued 的工具 | 无 | — | **不保护**。只能事后从 PR／commit 中识别并拒绝整合 |

---

## 4. 机制设计：Work Claim

### 4.1 对象

不新建任务系统。一个 claim 是对**已存在 Canonical Task** 的一次有时限、有 fence 的执行占用。

```
work_claims_v1
  claim_id            uuid PK
  user_id             uuid            -- Owner
  task_id             uuid            -- 必须是该用户的 active Task（复用 execution_intent 身份）
  holder_binding_id   uuid            -- 持有者 Binding（Host 身份）
  holder_session_ref  text            -- client_session_id，仅审计
  base_commit         text            -- 声明的起点 commit
  write_set           text[]          -- 仓库路径或 glob，规范化、排序
  trigger_refs        text[]          -- 规范化触发源：ghsa:GHSA-xxxx、ci:<check>@<base_sha>、issue:<n>、pr:<n>
  fence               bigint          -- 该 task 的单调 epoch；重新获取或接管才 +1
  lease_version       bigint          -- 续期 +1，不改 fence
  issued_at, expires_at, hard_deadline_at   timestamptz
  renewals            int
  progress_ref        text            -- 最近一次续期提交的进展证据（head SHA 或 Receipt id）
  budget              jsonb           -- {ci_minutes_cap, attempts_cap, concurrent_cap_consumed}
  status              text            -- ACTIVE | DRAINING | RELEASED | EXPIRED | SUPERSEDED
  receipt_id          uuid            -- 创建 Receipt
unique (user_id, task_id) where status in ('ACTIVE','DRAINING')
```

claim 的创建、续期、释放、接管都走现有 `clued_private` 事务模式：先 `currentness_user_lock(user_id)`，再 `pg_advisory_xact_lock('work-claim:'||user_id)`，与 Projection Refresh 一致，不与 checkpoint 交叉死锁。

### 4.2 RPC（MCP 工具）

| 工具 | 作用 | 原子性 |
| --- | --- | --- |
| `clued_work_claim` | 输入 task_id（或 `{title, execution_bucket, execution_intent}` 原子创建 Task 后再 claim）、base_commit、write_set、trigger_refs、估算预算。一个事务内：校验 Task 身份与 Binding 读写权；计算冲突（4.3）；无冲突则插入 ACTIVE claim，fence = 该 task 历史最大 fence + 1；返回 claim_id、fence、expires_at、Receipt。有冲突则返回 `work_claim_conflict` 与冲突 claim 的 id、持有者、expires_at、重叠的路径／trigger，不插入。 | 单事务，幂等键 = `<session>:<task_id>:claim` |
| `clued_work_renew` | 必须携带 claim_id + fence + lease_version + **progress_ref**（新 head SHA 或新 Receipt）。progress_ref 与上次相同 → 拒绝 `work_claim_no_progress`。成功只延长 expires_at、lease_version +1，不动 fence。超过 hard_deadline_at 或 renewals 上限 → 拒绝。 | 单事务 |
| `clued_work_release` | 持有者主动释放；带 outcome（completed / abandoned）与证据引用。 | 单事务 |
| `clued_work_verify` | 只读。输入 claim_id、head_sha、base_sha、changed_paths[]；返回 ADMITTED / REJECTED 及原因。供 CI gate 与 required check 调用，使用只读 Binding。实现：可选 `pr_ref` 时首次准入把 claim 绑定到该 PR（一条 Receipt），MCP 工具从迁移 `20261002072000` 一起开放 `pr_ref`；不带 `changed_paths` 时不检查路径，CI 的 PR 检查总会带，手动触发的准入有意不带 | 只读；带 `pr_ref` 时写一条绑定 |
| `clued_work_takeover` | 对 EXPIRED 或 DRAINING claim 发起接管：新 claim 以 fence +1 创建，旧 claim 标 SUPERSEDED。不自动触发，只由新持有者显式调用；Owner 决定或 profile 允许时才可对未过期 claim 强制接管。 | 单事务 |

`clued_session_resume` 增加返回：`contract_version`、`active_work_claims`（本用户所有 ACTIVE claim 的 task_id、write_set、trigger_refs、expires_at）。合规 Agent 在 resume 时就能比对自己的意图。

### 4.3 冲突判定（确定性，不靠语义理解）

两个 claim 冲突，当且仅当满足任一：

1. **同一 task_id**：已有 ACTIVE／DRAINING claim（这是 execution_intent 唯一性的执行层延伸）。
2. **write_set 路径重叠**：规范化后任一路径或 glob 相交。`apps/clued-cloud/package-lock.json` 这类共享文件会直接相交。
3. **trigger_refs 重叠**：任一规范化触发源相同。#443／#444／#445 都会写 `ghsa:GHSA-vcvr-r3jv-pc5j` 或 `ci:trivy@f7ba6ff`，在第二份 claim 时即冲突，与标题无关。

**实现（第 7 步评审修复，2026-10-01，迁移 `20261002050000`，Task `047e663e`）**：第 2 条最初只检查「一侧的 glob 覆盖另一侧的字面路径」，两个 glob 之间不比较，`apps/clued-cloud/**` 与 `**/package-lock.json` 不冲突。现按路径段比较：含 `**` 的段匹配任意多段；两个单段通配只要字面前缀与后缀相容就算相交。判定偏向「相交」：可能把两个实际不共享路径的 glob 判为冲突，不会漏判。

**实现（MINOR 修复，2026-10-02，迁移 `20261002072000`，Task `27b4f5e8`）**：
- 第 3 条按不区分大小写比较：`ghsa:GHSA-x` 与 `ghsa:ghsa-x` 相同。`@` 后都是至少 7 位十六进制、且一方是另一方前缀时也算相同，所以 `ci:trivy@f7ba6ff` 与完整 SHA 冲突。存储的 ref 保留声明时的大小写。
- 第 2 条中 `**/` 也匹配零层目录：`**/package-lock.json` 覆盖根目录的 `package-lock.json`，与 CI 路径过滤的理解一致。

不做：标题相似度、语义去重、自动合并意图（Decision `78ca0c07`）。语义不明确时 Agent 可以用 `clued_search_context` 做有上限的探索，但那不是准入判断。

### 4.4 租约、续期、过期、接管、fence

- **期限来自 profile**，不是无限 TTL：默认 claim 期限 2 小时，hard_deadline 24 小时，最多续期 12 次。数值在 `protocol/.../work-claim.profile.json` 中定义并随测试接受；缺省配置视为失败，不视为无限。
- **续期必须带进展**：heartbeat 不是进展。progress_ref 不变即拒绝续期，到期自然过期。（复审 7 m3 更正：服务端只检查 progress_ref 非空且没用过，不核验它是不是提交或 Receipt。它只挡住原样重复的心跳；一个空转的 Agent 换着字符串续期，实际上限是续期次数（12）与 24 小时硬截止；硬截止过了，它也可以重新认领同一 Task。）
  - **实现（2026-10-02，迁移 `20261002072000`）**：本 claim 以前任何一次续期用过的 progress_ref 都会被拒，`x,y,x,y` 交替不再通过（`progress_refs` 列记录历史）。
- **幂等键只代表一件工作（迁移 `20261002072000`）**：`clued_work_claim`／`clued_work_takeover` 记下操作、scope、Task（或被接管的 claim）与规范化 write_set 的哈希。
  - 同一个键换了这些内容，返回 `work_claim_idempotency_conflict`，不再返回无关的旧 claim。
  - 键对应的 claim 已不再有效（释放、过期、被接管）时，重放返回 `work_claim_idempotency_spent`。
  - 重试时省略可选字段（trigger_refs、base_commit、会话、租期、预算）仍按重放处理。
- **DRAINING**：持有者声明「已派出、不可取消的动作还在收尾」。它在到期前一直阻止冲突，也不能被接管；到期后才可接管或由持有者释放。
- **过期只拒绝新效果，不证明旧进程停止**：过期后 claim 进入 EXPIRED；旧持有者的分支仍存在，但其 claim_id + fence 在 `clued_work_verify` 下 REJECTED，无法通过 L0。它不能再续期，只能对新 claim 发起"采纳分支"请求（人工或新持有者决定）。
- **fence 单调**：只在 claim 创建与 takeover 时 +1；续期不动。服务恢复、备份回滚不得回退 fence：fence 来源于 `max(fence)+1` 的事务内计算，不来自客户端。
  - **实测（第 7 步，PR #467）与此不符**：从较旧的表副本恢复后 `max(fence)` 会回退。重新签发的 claim 拿到相同 fence 数值，但 claim_id 不同；恢复点之后签发的 claim_id 在 verify 下为 `claim_not_found`。不回退需要表外的单调 fence 来源，或修改本条（Task `27b4f5e8` 第 4 条）。
  - **已知限制（Owner Decision `2b23eb0c`，2026-10-02）**：不改 fence 来源。数据库从备份恢复后、Agent 再开工前，运行 `apps/clued-cloud/scripts/work-claims-after-restore.sql` 一次：恢复回来的 ACTIVE／DRAINING 认领标为 RELEASED（abandoned），所有 fence 加一百万，使新认领与接管拿到的 fence 高于恢复前签发过的任何 fence。步骤写在 `apps/clued-cloud/docs/production-release.md`「After a database restore」，验收测试 `work-claims-acceptance-db` 覆盖。
- **多资源一次性获取**：write_set 整体在一个事务中判定，没有逐路径加锁，没有持锁等锁，不会死锁。
- **优先级不抢占**：Global Frontier 的 Pin 或 priority 变化不自动 takeover 一个 ACTIVE claim。

### 4.5 预算

复用 N4 模式：

- **每 Binding 并发 claim 上限**（默认 3）：一个失控 Host 不能把所有 Task 都占了。
  - **实现（2026-10-02，Owner Decision `533a5286`，迁移 `20261002060001`）**：改为每个会话（Agent 自报的 `holder_session_ref`）最多 3 个活认领、每个 Binding 合计最多 10 个。原因：Owner 的所有 Claude Code 会话共用一个 Binding，原来的「每 Binding 3 个」会让并行会话互相挤占。会话标识是自报的，所以保留 Binding 总上限兜底；没有 `holder_session_ref` 的认领单独算一组。拒绝时 `limit` 字段写明撞到的是哪个上限。
- **每 claim CI 分钟上限**（原设计）：`admission-gate` 在放行重任务前调用 `clued_work_verify` 并上报本次预计分钟数；超出上限返回 REJECTED，重任务不启动。实际消耗由 workflow 完成后以 observed 回写（finalize）。
- **模型 token**：claim 只记录 Agent 自报的估算，标为 `declared_unenforced`。不宣称预留。
- （原设计）取消、失联或 UNKNOWN 时**不释放预留**；只有 finalize 或 takeover 事务才结算。没有分钟预留后不再适用。
- **实现（2026-10-02，Owner Decision `a264ea02`，Task `80aea04a`，迁移 `20261002100000`）**：分钟预算、finalize 与预留结算不做，改为数据库内强制的两个次数上限，不给 CI 可写凭据：
  - `attempts_cap`：一个 Task 在任意 24 小时内最多 10 次新认领或接管；超出时 `clued_work_claim`／`clued_work_takeover` 返回 `work_claim_budget_exhausted`，`limit` 为 `max_claims_per_task_24h`，附 `claims_last_24h` 与 `retry_after`。已签发认领的幂等重放不受影响。
  - 每 claim 的 PR head 上限：带 `pr_ref` 与 `head_sha` 的 verify 在放行时把该 head 记入 `admitted_heads`；一个 claim 最多放行 20 个不同 head，再来新 head 判 REJECTED（`claim_head_cap_reached`），重任务不跑。同一 head 重跑或每小时复核不计数；不带 `pr_ref` 的 verify（手动触发、Agent 自查）不记录。
  - `budget` 字段仍原样保存、不校验；模型 token 不计。
- **替代（2026-10-03，Decision `136a000e`）**：上面两个次数上限由 [GenericWorkClaim.v0.1.md §10](GenericWorkClaim.v0.1.md) 取代：新认领次数改为令牌桶（迁移 `20261003050000`），每 claim 的 head 上限改为每 Task 任意 24 小时 40 个 head（迁移 `20261003180000`，Task `bb9f1e36`，拒绝原因 `task_ci_head_cap_reached`）。

### 4.6 执行层细节

**L0a：`main` required check `clued-work-admission`**

- 一个无路径过滤的 workflow，GitHub 托管 runner，只做一次 HTTPS 调用 `clued_work_verify`（只读 Binding 放在 GitHub secret）。
- 输入：PR head SHA、base SHA、变更文件集（`gh api .../files`）、PR body 或最后一个 commit trailer 中的 `Clued-Work-Claim: <claim_id>`。
- 判定：claim ACTIVE 或 DRAINING 且未过期；holder 不校验 GitHub 身份（都是 Owner），校验 fence 为该 task 当前最大；变更文件集 ⊆ write_set；base_sha 等于或晚于 claim.base_commit。任一不满足 → 失败并写明原因。
  - **实现（2026-10-02，Owner Decision `36b50981`，Task `d95ee6ea`）**：「base_sha 等于或晚于 claim.base_commit」改为只提示。claim 的 base_commit 比 PR 的 base 新时，检查摘要写一条 `base_behind_claim` 提示，仍放行。原因：base_commit 由 Agent 自报，这条比较拦不住错误的 claim；Codex 在新 main 上重新认领而分支仍基于旧 main 时，#441 因此被拒三次。base_commit 在仓库里找不到（`claim_base_unknown`）仍拒绝。
- **Owner 在 GitHub 网页直接改文件开的 PR**（Owner Decision `36b50981`）：同样需要 claim，没有豁免。Agent 与 Owner 共用一个 GitHub 账号，CI 分不出是谁改的，豁免会被 Agent 用来绕过。做法：网页改动前让任一 Agent 为该 Task 建 claim，把 `Clued-Work-Claim: <claim_id>` 贴进 PR 正文；改正文会重跑检查。
- 范围扩张（变更文件超出 write_set）→ 失败，提示先 `clued_work_renew` 携带扩大的 write_set（扩大时重新做冲突判定）。
- 加入 ruleset required 列表后，这条和 gitleaks、trivy 一样是无过滤 check，不会出现"等不到"的问题。
- 同一 check 顺带输出一张汇总表：按本 PR 变更路径判定哪些路径过滤的 workflow **适用**、各自在当前 head 上的结论、哪些**不适用**。这就是 2026-10-01 根因审计第 4 项要的"始终返回结果的汇总检查"，不必另开一个。
- 自报 JSON、伪造签名不算：check 由 workflow 从 Clued 实时查询，Receipt 在 Clued 侧。**同名 check 未覆盖**：PR 可以新增一个同名 job，见下文「仍未覆盖」。
- **实现偏离（第 3 步，2026-10-01，PR #454）**：生产的 `/mcp` 由委托 OAuth provider 接管，只接受 OAuth access token，直接的 `clued_bnd_` Binding token 会被 401 拒绝；因此 CI 不走 MCP，而是直接调 Clued 数据库 PostgREST 的 `clued_work_verify_v1`（公开 publishable key + Binding token 的 SHA-256，由数据库 `resolve_binding` 鉴权，与 Worker 内部走的是同一条路）。强制与否不跟随 `CLUED_WORK_CLAIMS_V1`，而是 Owner 的仓库变量 `CLUED_WORK_ADMISSION_ENFORCE=true`：未打开时 check 只做 advisory（有 claim 就把判定写进 summary，没有则报 NOT_ENFORCED，一律放行），避免迁移一应用就拦住所有 PR 而 Agent 还无法建 claim；打开后缺 trailer、REJECTED、RPC 缺失、token 被拒、传输错误一律 fail closed。

- **实现（第 7 步评审修复，2026-10-01，Owner Decision `64d9b418`，Task `95a93218`／`21a77b34`）**：
  - 评审发现原 check 在 `pull_request` 事件下运行 PR 自带的 workflow 与脚本，PR 可以改写判定。现改为 `pull_request_target`：workflow 与 `scripts/ci/clued-work-admission.mjs` 取自 base 分支，不 checkout、不执行 PR 代码，PR 只经 API 读取，每次运行重新读取，因此修改正文（`edited`）或重跑都看到当前 trailer 与 head。没有 `pull_request` 触发：改动本 workflow 文件的 PR 也由 base 分支上的版本判定。（复审 7 MAJOR-3：这只保证 PR 改不了对它自己的判定；PR 合并后，它的改动就是之后所有 PR 的判定代码，所以改动准入本身要 Owner 复核，见下。）
  - 每次 verify 带 `pr_ref`（`owner/repo#n`）。第一个判定为 ADMITTED 的 PR 把 claim 绑定到自己（一条 `work_claim_bind_pr` 回执），之后其他 PR 引用同一 claim 返回 `claim_bound_to_other_pr`。这是 verify 唯一的写入，在 CI 持有的只读 Binding 下进行。接管或新 claim 从未绑定开始。
  - `clued-work-admission-reverify.yml` 每小时检查一次：对发往默认分支、非草稿、head 上最新的 `clued-admission-verified` App check 为成功的 PR 重新判定，claim 已过期、释放、被接管或绑定到别的 PR 时由 App 发一条失败 check（无 App 私钥时重跑本 PR 自己的准入运行），使必需检查变红（复审 7 MAJOR-1；原先按 head 取最新一条准入运行，可被同 head 的另一个 PR 或一次取消的运行废掉）。判定过期的窗口因此不超过约一小时（复核 job 失败时除外，会显示为失败的定时运行），合并时并不实时重验。被挡住的 PR 在认领恢复后推一个提交或编辑 PR 即重新准入。
  - PR 文件列表少于 `changed_files`（API 3000 文件上限）时强制模式判 REJECTED（`changed_files_truncated`）。
  - **仍未覆盖**：
    - PR 可以新增另一个 workflow，其 job 也叫 `clued-work-admission`，两者都是 GitHub Actions 的 check run。**处理（Owner Decision `37e01bb1`，2026-10-02）**：仓库属个人账号且私有，没有组织 required workflows。准入 workflow 在判定后用 Owner 的专用 GitHub App 再发一个 `clued-admission-verified` check（`--mode app-check`，App 私钥只在 `clued-admission` environment 中）。Owner 建好 App、在 main ruleset 把该 check 设为必需并限定来源为该 App 后，PR 无法冒充。App 未配置时这一步只提示、不发检查。
    - L0b 的 `admission-gate` 仍是 PR 定义的 job，PR 可以删掉 `needs:`。**处理（同一决定）**：准入检查读取 PR 新增或改动的 workflow：base 上已有闸的 workflow，或新加的含自托管 job 的 workflow，必须保留与 `GATE_JOB_SHA256` 一致的 `admission-gate` job，其余每个 job 都 `needs` 它，且 `if:` 为闸条件 `&&` 一个整体括号组；否则判 REJECTED（`workflow_gate:<文件>:<原因>`），PR 无法合入。闸 job 改为检出 base 分支（或默认分支）代码，PR 改脚本也绕不过。已知代价：被拒的 PR 上，重任务在拒绝前可能已经跑过一次。base 上已有、本来不加闸的轻量 workflow（Owner Decision `75abfe80`）不在检查范围。修改闸 job 本身需两步：先在 `GATE_JOB_SHA256` 中加入新摘要并合入，再改各 workflow。
    - 任何同仓 PR 的 workflow 都能引用仓库 secret，所以 `CLUED_CONTEXT_READ_TOKEN` 只能靠 environment 限定加轮换保护。
- **实现（token 隔离，2026-10-02，Task `95a93218`，PR #479）**：
  - `admission-gate` 不再调用 Clued，也不再拿 `CLUED_CONTEXT_READ_TOKEN`（它跑的是 PR 的代码）。它等待本 head 上 clued-admission App 的 `clued-admission-verified` check，只认本事件的 main 准入运行发出的、写着本 PR 的那条（该运行发出多条时看最新的），成功才放行（复审 2 N3c、复审 3 N-R1、复审 4 m1、复审 5 n1；原先看 `clued-work-admission.yml` 的 `pull_request_target` 运行的结论，现在运行列表只用来找本事件的准入运行）；重跑一律不放行（复审 3 N-R3）。强制模式下等不到运行、到期仍未结束（默认 480 秒）或 GitHub API 出错都不放行；advisory 模式从不拦截。来自 fork 的 PR 可能拿不到仓库变量，所以闸对 fork PR 一律按强制处理，只跟随准入运行的结果；准入运行在 base 仓库读变量，advisory 时总是成功（Task `27b4f5e8` 第 11 条，2026-10-02）。
  - 只有跑 base 分支代码的 workflow 引用该 token：`clued-work-admission.yml`、`clued-work-admission-reverify.yml`，以及 PR #480 起的 `clued-work-admission-dispatch.yml`。三者都在 `clued-admission` environment 中运行。Owner 已（2026-10-02）将该 environment 的部署分支限定为 `main`、不设审批人，把 token 移为 environment secret、删除仓库 secret 并轮换；此后PR 新增或改写的 workflow（运行在 `refs/pull/N/merge`）即使声明该 environment 也拿不到 token。
  - 仓库检查（`scripts/ci/clued-work-admission.test.mjs`）断言只有上述 workflow 引用该 token 的 secret（复审 3 起名为 `secrets.CLUED_ADMISSION_CLUED_TOKEN`，旧名 `CLUED_CONTEXT_READ_TOKEN` 已停用）。
  - 仍未覆盖：同名 check 伪造（见上）。另外 PR 可以改写自己的 workflow、删掉 `needs: admission-gate`：闸是 PR 自己的 job，只能控制合规 PR 的花费，不是强制边界。
- **实现（加闸范围与手动触发，2026-10-02，Owner Decision `75abfe80`，Task `29128827`）**：
  - 新增加闸：`public-mcp-behavior.yml`、`public-mcp-protocol.yml`（装依赖、起本地 MCP，behavior 还起数据库）。`model-program-*`、`mps03-native-agent`、`multitrack-governance-projection`、`node-profile-policy` 是 Python 校验，不加闸：闸任务本身的开销与等待超过它们。（复审 2 更正：它们在自托管 Windows 上跑 PR 的代码，一次几分钟而不是几秒；现在每个 job 有 20 分钟超时，`model-program-m0` 除外，它的文件哈希被冻结的 m0 清单锁定。）
  - 手动触发：Agent 用 Owner 账号，「只许 Owner 触发」不等于要求认领。`clued-g4-database`、`information-flow-e2e`、`clued-connection-authorization` 的 `workflow_dispatch` 现在要带 `admission_run_id`。流程两步：
    1. 在默认分支触发 `clued-work-admission-dispatch.yml`，参数 `workflow`（上述三者之一）、`ref`、`claim_id`（可选 `scope`）。它在 `clued-admission` environment 中持有 token，向 Clued 校验该 claim（`clued_work_verify_v1`，带 ref 的 head，不带 changed_paths），运行名为 `admit <workflow> <ref> <claim_id>`；不在默认分支时 job 不运行。
    2. 在该 ref 上触发重任务 workflow，`admission_run_id` 填第 1 步的 run id。其 `admission-gate`（无 token）只在该运行是默认分支上的 `workflow_dispatch`、成功、30 分钟内、运行名指向本 workflow 与本 ref 时放行。
  - 一次准入在 30 分钟内可用于同一 workflow 与 ref 的多次触发；claim 本身仍须有效（第 1 步校验时）。push 与定时事件不经此闸。
  - 合同 v12（`skills/clued/references/agent-contract.md` §1.7）写入这两步，并写明准入只在检查运行时判定、每小时复核（Task `ace2fb96`）。合同文本随 Worker 下发，Worker 发布前已部署的服务仍下发 v11。缺 `admission_run_id` 时闸的提示写明做法。

- **实现（复审 7，2026-10-05，Owner Decision `b43f8b8a`，Task `c7b721ee`）：Owner 复核。**
  - 原因：ruleset 不要求审批，Agent 合并自己的 PR，准入放行的改动合并后就是 `main` 的代码，之后所有运行都按它执行。改掉守护生产的代码，守护就没了。
  - 需要 Owner 复核的改动（`ownerReviewFindings`、`protectedPathFindings`）：
    - 保护路径：`scripts/ci/clued-work-admission.mjs`、`scripts/ci/clued-release-grant.mjs`、`scripts/runner/**`、`.github/workflows/clued-work-admission*.yml`、`.github/workflows/clued-cloud-production-release.yml`、`apps/clued-cloud/app/supabase-public-config.ts`（准入向哪个 Clued 查询）。
    - 声明了 environment 的 workflow（改动前或改动后有 `environment:`，或用了锚点合并 `<<:`），以及删除这样的 workflow。目前是发布、存储执行与读取配置、部署后核验、发布标签和三个准入 workflow。
    - 新引用的 secret（按名比较；按计算名读取、`toJSON(secrets)`、`secrets: inherit` 记为 `*`）。
    - 含自托管 job 的 workflow 的 `on:` 改动；新增的含自托管 job 的 workflow 除 `pull_request`、`workflow_dispatch` 外的触发器。
  - 做法：准入判定为 ADMITTED 后，用准入 Binding 调 Clued 的 `clued_owner_grant_admission_door_v1`，动作 `repo.protected_change`，资源 `repo:<owner>/<name>/<head 提交>`。有覆盖它的有效授权就放行（摘要写 `owner_review_granted`）；没有就开（或复用）一条待确认请求，判 REJECTED 并在原因里给出确认链接。Owner 在登录的 Clued 页面批准后，编辑 PR 或推提交即重新判定。
  - 一份授权对一个提交只用一次：第一次准入用掉一次并记 `OWNER_GRANT_USED`（`door: ci-admission`），之后同一提交的运行（复核、编辑 PR）凭这条记录放行，不再用次数；授权撤销或过期后不再放行。「只批这一次」因此恰好覆盖一个提交。
  - 只有准入 Binding（Owner 标了 `ci-admission` 之后）能调这个门口，只需 `context:read`。
  - 强制开关是 Owner 的仓库变量 `CLUED_OWNER_REVIEW_ENFORCE=true`。未打开时只在摘要里提示；打开后门口缺失、被拒或传输错误都判 REJECTED。

**L0b：重任务 workflow 的 `admission-gate` job**

- `information-flow-e2e.yml`、`clued-g4-database.yml`、`clued-cloud-node22-install.yml`、`clued-connection-authorization.yml`、`public-mcp-behavior.yml`、`public-mcp-protocol.yml` 这些自托管重任务加一个前置 job，与 L0a 同一脚本；`needs: admission-gate` 且 `if: needs.admission-gate.outputs.admitted == 'true'`。
- 未 admitted 的 PR 仍跑 gitleaks、trivy（它们是 required，且便宜），其余跳过并在 check summary 写"未被 claim 覆盖"。
- 这一层挡住的是本次事故中真实烧掉的东西：三份 PR 各自触发了 Information Flow E2E（12 分钟）、Supabase 栈、isolated-candidate。

**L1：Clued DB**

- 全部 RPC 为 `security definer`，revoke 客户端直接执行，与现有 `clued_private` 模式一致。
- claim、续期、释放、接管与 PR 绑定只写 `clued_audit_receipts`，不写 Event（Owner Decision `8f98387a`，2026-10-02，Task `27b4f5e8` 第 8 条）。原设计要求同时写 Event；改为只写 Receipt，因为写 Event 会让每次认领、续期、释放都使其他会话的 checkpoint 变 STALE 并刷满工作日志。谁在做什么由 resume 的 `active_work_claims` 提供。

**L2：合规路径**

- agent-contract §1 增加："任何会修改仓库文件、运行构建或测试、派发子任务的工作，先 `clued_work_claim`。返回冲突时停止，向 Owner 报告冲突 claim；不得换标题、换 Task、换 request key 重试。"
- `clued_session_resume` 返回 `contract_version`；Skill 比对本地 `agent-contract.md` 版本行，不一致则拒绝开工并说明。
- Agent 在 PR body 与最后一个 commit 的 trailer 写 `Clued-Work-Claim: <id>`。

**L3：Claude Code SessionStart + PreToolUse hook**

- SessionStart hook 调用 Clued 只读 API 取 `active_work_claims`，以附加上下文注入第一轮。模型在消耗第一个 token 之前就看到"谁在做什么、改哪些文件、何时到期"。这是本仓库内 Claude Code 会话能做到的最早一刻，仍属合规层：hook 可关、Host 可换。

- PreToolUse hook：匹配 Bash 中的 `git push`、`gh pr create`、`npm (ci|install|run build|test)`、`pytest`、`node --test`，以及 `mcp__github__create_pull_request`、`push_files`。2026-10-02 起（Task `27b4f5e8` 第 10 条）另匹配：任意 `npm run` 与 `npx` 脚本；`gh workflow run`、`gh run rerun` 与 MCP `actions_run_trigger`（启动 CI）；远程会话 `create_session`、`Workflow` 与非只读的 `Agent` 子任务（Explore、Plan 等只读子代理除外）；对仓库文件的 `Edit`／`Write`／`NotebookEdit`（`.clued/`、`.git/` 与仓库外路径除外）。没有 `CLUED_WORK_CLAIM` 环境变量或 `$CLAUDE_PROJECT_DIR/.clued/work-claim.json`（由 `clued_work_claim` 成功后写入）则阻止一次并提示先 claim。
- 与 Stop hook 同样可关、可删；标为 L3，不进任何"不可绕过"声明。
- **实现（第 6 步，2026-10-01，Owner Decision `9297922c`）**：`scripts/hooks/clued_work_claim_guard.py` 一个脚本按 `hook_event_name` 服务三个事件，由 `.claude/settings.json` 注册。SessionStart 注入 §1.7 规则与本 checkout 记录的有效认领；设了只读 Binding token `CLUED_CONTEXT_READ_TOKEN` 时，另经 PostgREST `clued_work_claims_active_v1`（公开配置读自 `app/supabase-public-config.ts`，只发 token 的 SHA-256）读取该用户全部有效认领，失败只降级为提示。PostToolUse 在 `clued_work_claim`／`renew`／`takeover`／`release` 成功后更新 `.clued/work-claim.json`（已 gitignore）。PreToolUse 在上述命令与 `mcp__*__create_pull_request`／`push_files`／`create_or_update_file` 前检查：没有有效认领、也没有 `CLUED_WORK_CLAIM` 时，「发布」与「花钱」两类各在每个会话拦一次。`CLUED_WORK_CLAIM_GUARD=off` 关闭。PreToolUse 不校验认领是否覆盖改动路径，这由 CI 的 `clued-work-admission` 负责。

### 4.7 不保护什么（必须原样写进任何完成声明）

- Host 在第一次调用 Clued 之前消耗的模型 token。
- 在 Host 本机运行的 install／build／test（除 Claude Code + hook 未关闭的情况）。
- 不调用 Clued、不开 PR 的工作（它们也不会消耗共享资源）。
- Owner 临时禁用 ruleset 期间的合并。
- `main` 上未经人审的代码（复审 7 MAJOR-3）：ruleset 不要求审批，Agent 合并自己的 PR。Owner 复核（§4.6）只覆盖其中列出的改动。不覆盖：声明 environment 的 workflow 所运行的其他脚本与依赖（例如发布 workflow 调用的构建脚本、`package.json`）、不含 environment 的 workflow 的步骤、`apps/` 下的应用代码。它们合并后在 `main` 上以 `main` 的身份运行。Owner 复核开关打开之前，以上所有改动都不需要 Owner。
- 仓库级 secret 与 GitHub 托管 runner 分钟（复审 7 m5）：任何能推分支的 Agent 都能加一个 `on: push`（任意分支）的托管 workflow，最多 256 份 matrix、每份 6 小时，读取所有仓库级 secret（例如 `OPENAI_API_KEY`、`CI_HEALTH_GITHUB_TOKEN`、`CLUED_E2E_EMAIL` / `CLUED_E2E_PASSWORD`）。准入、gate、runner 检查都不经过。生产相关的 secret 应放在只限 `main` 的 environment（`clued-release`、`clued-admission`）里；`CLUED_RELEASE_TAG_TOKEN` 的 job 已进 `clued-release`，secret 由 Owner 移入。`CLUED_PRODUCTION_BACKUP_KEY`、`CLUED_STORAGE_SOURCE_*` 是否只在 environment 中，从仓库无法核验。
- Agent 的 GitHub 凭据（复审 7 m7）：Agent 用 Owner 的 GitHub 身份，即仓库管理员（`docs/maintenance/main-admission-self-test-deadlock.md`）。持有管理权限的凭据能改 ruleset、`CLUED_WORK_ADMISSION_ENFORCE`、`CLUED_RELEASE_GRANT_ENFORCE`、`CLUED_OWNER_REVIEW_ENFORCE` 等变量、environment 的分支策略与 secret，本设计的所有 GitHub 侧保证都以 Agent 不这样做为前提。要去掉这个前提，Agent 需要一个没有 Administration、Secrets、Variables、Environments 权限的凭据（例如只有 Contents 与 Pull requests 写权限的 GitHub App 或细粒度 token）。
- PR 正文或手动触发填别人的认领（已知项，复审 7 更正影响）：仓库侧不知道 PR 由谁打开。非持有者可以：用别人的认领让自己的 PR 准入并合并（改动在对方 write_set 内即可），绕过合并侧的互斥；抢先把对方的认领绑到自己的 PR，对方的 PR 此后得到 `claim_bound_to_other_pr`，认领作废；在多份模式中借此决定哪一份被采纳；计入对方 Task 的 CI 额度。只有合规 Agent 不这样做。
- 同一 head 的多个 PR（复审 7 n4）：App check 按提交生效。同 head 另一个发往 main 的 PR 准入失败（或被复核挡住）时，失败 check 成为该提交上最新的一条，也挡住原 PR，直到它的下一个事件重新准入。
- Claude Code 钩子不匹配 `mcp__github__merge_pull_request`、`create_branch`、`delete_file`、`enable_pr_auto_merge`（复审 7 n3，未改）。钩子是合规层（L3），不影响 L0 的保证。
- 直接数据库／Storage／部署工具的管理员路径：各自有独立授权，本设计不覆盖。生产迁移的重复执行（2026-10-01 #435 迁移在 02:47 与 03:13 被两个会话各跑一次）由独立的迁移原子入口承接（Project Task `a15cb2d2`，候选、已暂停）；work claim 只保证改迁移文件的开发工作不重复，不保证迁移只被应用一次。两者互补，不合并。

---

## 5. 在 #443／#444／#445 上回放

| 时间 (UTC) | 事件 | 有本机制时 |
| --- | --- | --- |
| 04:0x | 会话 A（#443 作者）因 Trivy 变红决定附带升级 Next | 合规路径：`clued_work_claim(task=依赖守卫 Task, write_set += package.json/lock, trigger_refs += ghsa:GHSA-vcvr-r3jv-pc5j)` → ACTIVE，fence 1 |
| 04:1x | 会话 B（Codex，#444）开始安装依赖 | 合规路径：resume 已返回 A 的 claim 含同一 ghsa；或 `clued_work_claim` 返回 `work_claim_conflict`。B 停在 resume／claim，成本为零次构建。若 B 不合规继续推 PR：L0b 不跑重任务，L0a 不可合并 |
| 04:20 | 会话 C（Claude Code，#445）独立开出 | 同 B。C 的 gitleaks 失败本来就会跑；Information Flow E2E、Supabase、isolated-candidate 不会启动 |
| 之后 | A 的 claim 到期未续 | A 的 PR 无法合并；要么 A 续期带新 head，要么 B／C 对 EXPIRED claim 发起 takeover 并采纳 A 的分支 |

**实际（2026-10-02）**：「A 的 PR 无法合并」只在检查运行时成立。`clued-work-admission` 通过后，claim 过期并不会让已有的绿色检查自动变红。`clued-work-admission-reverify.yml` 每小时重跑一次，claim 已不再准入时把检查变红。所以在这次重跑前约一小时内，PR 仍可合并。

纪要第二节的三种情况：不同标题（trigger_refs 相交）、中途扩大范围（#443 扩大 write_set 时 renew 重新判冲突）、不同分支同一 lockfile（write_set 相交）都在 4.3 的三条规则内。

---

## 6. 验收矩阵映射（纪要第七节 → 测试点）

| 纪要故障／绕过 | 测试点 | 层 |
| --- | --- | --- |
| 无 Task、伪造 claim、漏报 write_set | `clued_work_verify` 对不存在／伪造 claim_id、变更文件 ⊄ write_set 返回 REJECTED；gate job 不放行 | L0／L1 |
| 重演 443／444：不同标题、同意图或同 lockfile | 两个 Binding 并发 `clued_work_claim`，相同 trigger_ref 或相交路径，恰一个 ACTIVE（barrier 测试，复用 projection-refresh-pipeline-db 的并发模式） | L1 |
| 同时领取、响应丢失后重试 | 同幂等键重试返回原 claim；不同键同资源返回 conflict | L1 |
| 过期 owner、网络分区、服务重启 | 过期 claim 的 fence 在 verify 下 REJECTED；takeover 后 fence +1；备份恢复后 `max(fence)` 不回退（迁移测试）。**实测：前两项通过；备份恢复后会回退，按已知限制由恢复后脚本补救，见 §4.4** | L1 |
| 持续 heartbeat 却无进展 | progress_ref 不变的 renew 被拒；到 hard_deadline 自动 EXPIRED | L1 |
| 非幂等请求成功但回包丢失 | claim 创建用幂等键；CI gate 对同一 head 重复查询返回同一判定 | L1／L0 |
| 多资源反序竞争、cleanup 崩溃 | write_set 整体一次事务；无逐路径锁；EXPIRED 清理不删 ACTIVE 行 | L1 |
| raw 工具修改后尝试整合、篡改 Receipt 或 verifier | 无 trailer 或 trailer 指向他人 claim 的 PR 在 L0a 失败；verifier 从 Clued 实时查，不读 PR 自报 | L0 |
| 权限撤销、approval 过期、预算耗尽 | Binding 撤销后 renew／claim 失败；预算超限 verify 返回 REJECTED 且无自动追加。**实测：Binding 撤销项通过（PR #467）；预算未实现，按 Decision `a264ea02` 改为次数上限，见 §4.5** | L1／L0 |

测试用可控时钟（`clock_timestamp` 由测试夹具注入或用 `pg_sleep` 边界）、并发 barrier、真实行计数与 Receipt。

---

## 7. 与 Owner 要求逐条对应

| Owner 要求 | 本设计 |
| --- | --- |
| 许可有时效，故障不能永久霸占任务 | 2 小时期限、24 小时 hard_deadline、12 次续期上限，全部来自 profile；过期自动 EXPIRED |
| 能崩溃恢复、接管，避免死锁与无界重试 | takeover 以 fence +1 接管；write_set 单事务获取；attempts_cap 有界。**实现（Owner Decision `a264ea02`）**：每 Task 24 小时最多 10 次认领或接管，每 claim 最多放行 20 个 PR head；CI 分钟不计（Task `80aea04a`） |
| 不能把 Agent 自觉遵守作为安全前提 | L0 由 GitHub ruleset 与 workflow 强制，L1 由 Postgres 强制；L2／L3 明确标为合规层 |
| 不能直到提交时才发现重复 | 合规 Agent 在 resume／claim 即发现（第一次 Clued 调用）；不合规 Agent 在 CI 第一个 job 被挡住重任务，而不是等到合并 |
| 先复用既有机制 | claim 表与 RPC 逐字复用 Projection Refresh 的 lease／attempt SQL 模式；预算复用 N4；身份复用 execution_intent；fence 语义复用 kernel approval-lease；门禁复用现有 ruleset |

---

## 8. 实施顺序

第 1–7 步均已执行。第 7 步的两次复审均为 HOLD_FAIL，修复后待再复审（Task `869d2db7`）；其余状态见文首「当前状态」。以下为原计划，保留原文。

1. 迁移（Task `ca767208`）：`work_claims_v1` 表 + 五个 RPC + Event／Receipt 接线；DB 测试覆盖第 6 节矩阵。
2. Worker（Task `ed816cd8`）：五个 MCP 工具；`clued_session_resume` 增加 `contract_version` 与 `active_work_claims`。
3. CI（Task `f6311ff5`）：`clued-work-admission.yml`（无过滤）+ 重任务 workflow 的 `admission-gate` job；只读 Binding secret。
4. ruleset（Decision `b12d4703`）：把 `clued-work-admission` 加入 required（Owner 操作）。
5. 合同（Task `29ad7d4e`）：agent-contract v7 §1 新增 claim 步骤；Skill 与 Worker 下发同步。
6. hook（Task `178ff66c`）：PreToolUse 候选。
7. 独立评审 + 第 6 节矩阵实测（Task `2a5ae9ce`；修复后复审 Task `869d2db7`）。

每一步都是独立 PR，每一步合入前都要先按本设计 claim 自己的 write_set。第 1 步之前，本文件只是候选。

---

## 9. 证据

- 全库只读扫描（2026-10-01，本会话委派的只读 agent）：MCP 工具目录 `apps/clued-cloud/worker/continuity.ts:1115-1415` 无 claim／lease／admit 工具；`lease_id`／`lease_expires_at` 列仅存在于 projection refresh job 表；kernel lease／budget 模块仅被 `evals/kernel-next/*` 引用；`.claude/settings.json` 仅 Stop hook。
- Projection Refresh 实现说明：`apps/clued-cloud/docs/model-program-m0/post-commit-projection-refresh.md`；精确 key 租约：`apps/clued-cloud/supabase/migrations/20260923213100_projection_refresh_exact_key_lease.sql`。
- N4 预算：`apps/clued-cloud/supabase/migrations/20260930200000_storage_read_budget_n4.sql`。
- execution_intent：`apps/clued-cloud/supabase/migrations/20260922143312_context_v2_execution_intent_identity.sql`。
- Kernel：`kernel/policy/approval-lease.mjs`、`kernel/domain/attempt-fsm.mjs`、`kernel/runtime/external-invocation-ledger.mjs`；`protocol/continuity/v1/profiles/execution.profile.json`（`runtime_selected=false`）。
- Git Connector 合同：`development/contracts/repository/GitConnectorWriteContract.v0.1.md`。
- WorkLease 候选：`artifacts/clued-validation/structure-freeze-prep/acceptance-20260907/step2/package-inputs/Clued_Phase2_结构准备设计_候选_v0.1.4_20260906.md` §4.2、§12。
- PR 事实：Clued Note `46f46fed-f464-487b-8c4d-ca97436ab140`；整合顺序 Decision `8b22f847-9a32-4ea7-8f8e-03654d0b1d6f`；暂停与豁免 Decision `93eb4e76-bc36-452b-9813-a521a5b648d3` v3。
