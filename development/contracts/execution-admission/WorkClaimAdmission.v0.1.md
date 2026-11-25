# Work Claim Admission v0.1：多 Agent 执行准入与费用保护机制候选

状态：**部分实施。** 第 1–6 步已在生产生效，强制开启。第 7 步实测已完成；独立评审 HOLD_FAIL 的修复已合入；2026-10-03 的复审、2026-10-04 的复审 2 至复审 6（Task `869d2db7`）与 2026-10-05 的复审 7（Task `737699cd`）、复审 8（Task `c7b721ee`）、复审 9（PR #559 合并后，Task `d811ab16`）与复审 10（PR #561）均为 HOLD_FAIL，修复见下（Owner Decisions `38ddb8cf`、`b0c53143`、`b43f8b8a`、`f2bf949a`、`9dba872f`、`5a3b4935`）。复审 11（PR #561 head `12999b0`）为 PASS_WITH_FINDINGS（MAJOR 0），其 MINOR 与 NIT 已在同一 PR 修正。方向由 Owner 接受（Decision `78ca0c07`），不是架构接受。
日期：2026-10-01（状态更新 2026-10-05）
来源：Owner 上传的《Clued 多 Agent 执行协调与费用保护：讨论纪要与既有机制对账》（2026-10-01）的重新评估，以及对纪要第九节源码与合同的只读对账（固定在 commit `f7ba6ff312aa0e90095db1e28f5937920f30de3a`）。
通用化后续：任意资源、一个门卫多个门口、领取模式（独占/拆分/多份）的设计候选见 [GenericWorkClaim.v0.1.md](GenericWorkClaim.v0.1.md)（Task `52739939`）。
治理：起草时受 Global Decision `93eb4e76` 的暂停约束（只读评估与设计豁免）。该约束已由 Decision `78ca0c07`（2026-10-01）取代。各步实施由 Owner 逐步授权。本文件本身不授予实施、合并、部署或权限变更。

### 当前状态（2026-10-02，对照 main `f844d6a`）

- **已上线**：
  - `work_claims_v1` 与 transport、admission hardening、会话上限迁移已应用 clued-prod。
  - Worker 五个认领工具与 resume 的 `active_work_claims` 已发布。
  - `clued-work-admission` 是 `main` 的必需检查，`CLUED_WORK_ADMISSION_ENFORCE=true`（Merge Admission 第 6 步，2026-10-09 起不再读取该变量，始终强制）。
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
      - MAJOR-1：复核改读 App check（它写明 PR），只看发往默认分支的 PR，以该 head 上最新的 App check 是否成功为准；不再准入时由 App 直接发一条失败 check（`pr:<n>:run:<复核运行 id>`）挡住合并（复审 8 起，没有 App 私钥时复核报错，不再重跑准入运行）。复核 workflow 加 `checks: read` 与 App 私钥。
      - MAJOR-2：只有改名前也是 workflow 文件时才取 base；从别处改名进来或复制的按新增 workflow 检查。
      - MAJOR-3：新增「Owner 复核」（§4.6「实现（复审 7）」）：改动保护路径、声明 environment 的 workflow（改动或删除）、新增 secret 引用、改动含自托管 job 的 workflow 的触发器，准入要求该 head 提交上的 Owner Grant（`repo.protected_change`，迁移 `20261005120000_owner_grants_admission_door.sql`）。Owner 设 `CLUED_OWNER_REVIEW_ENFORCE=true` 后强制，之前只提示（Merge Admission 第 6 步起不再读取该变量，始终强制）。覆盖不到的写进 §4.7。
      - MAJOR-4：`scripts/runner/README.md` 第 6 步：临时（ephemeral）runner，或把 hook 设置放到服务账户写不了的地方（systemd drop-in / 服务注册表）、runner 目录除 `_work`、`_diag` 外只读、`--disableupdate`、`ptrace_scope≥1`。不加固时 runner 检查不是硬保证。
      - m1：`memory-publication-gate` 的自托管 job 只对发往默认分支的 PR 运行，两个 job 都从默认分支取校验脚本；runner 检查对 `pull_request_target` 读事件中 PR 的 base，不是默认分支就拒绝。
      - m2：判定为 ADMITTED 后再读一次 PR，head 变了就报错（不发成功）。
      - m5：`clued-release-tags` 的 job 进 `clued-release` environment，`CLUED_RELEASE_TAG_TOKEN` 可由 Owner 移进该 environment。其余写进 §4.7。
      - m6：采纳返回 `adopted:false` 且原因不是「不是份」（`no_copy_for_pr`、`not_a_copy`）时 job 失败。
      - n2：`runs-on` 与 `timeout-minutes` 的注释需要 `#` 前有空白。
      - m3、m4、m7、n1、n4 与已知项：文档更正（§4.4、§4.7、GenericWorkClaim §4.1、§8、§10.6）。
      - n3 未改：钩子属合规层（L3），改动在 `scripts/hooks/`，留作后续。
    - Owner 需要做的设置（合并后，复审 11 更新）：① 经发布 workflow 的 `migrate` 应用迁移 `20261005120000` 与 `20261005140000`（需授权）；② 发布 Worker，下发合同 v30 与确认页改动；③ 在 `/bindings` 把准入用的 Binding 标为 `ci-admission`（门口只认它，不标则所有保护 PR 在开关打开后以 `owner_review_unavailable:refused` 失败）；④ 在 main ruleset 打开「要求分支最新」；⑤ 设 `CLUED_OWNER_REVIEW_ENFORCE=true`（开关关着时门口不会被调用，无法事先试跑；打开后用一个只改 workflow 注释的 PR 走一遍：被拒、批准、编辑 PR、关闭再重开；Merge Admission 第 6 步起该变量不再读取）；⑥ 把 `CLUED_RELEASE_TAG_TOKEN` 移进 `clued-release` environment；⑦ 把 runner 换成临时（ephemeral）runner 或做 README 第 6 步；⑧ 到 `/grants` 看一眼此前批出的 `repo.protected_change` 授权。
  - 复审 8（2026-10-05，Task `c7b721ee`，对照 PR #559 head `650b95a`）：fresh-context 只读评审，HOLD_FAIL（BLOCKER 0 / MAJOR 2 / MINOR 5 / NIT 4，Note `7c64d5f6`）。复审 7 的 MAJOR-1、MAJOR-2、门口迁移、m1/m2/m5/m6/n2 与文档更正确认成立。
    - 新发现：
      - MAJOR-1：保护路径漏了准入 job 自己执行的测试文件。它们在持有准入 token 与 App 私钥的步骤之前、在同一工作区运行；合并一个改测试文件的 PR 后，之后每次准入都能改写准入脚本、拿走私钥、伪造 check。
      - MAJOR-2：environment / secret 的识别是逐行文本匹配，YAML 转义键（`"environmen\x74"`）、`?` 显式键、别名作键、块标量里的 `${{ secrets.X }}`、`Secrets.X`、外部可复用 workflow 都能躲过；新 workflow 带 `workflow_dispatch` 被算作「只 PR」。
      - MINOR：加闸 workflow 的超时与 matrix 不受限，新加闸 workflow 带 dispatch 可在 main 上无认领触发（1）；Owner 批准后编辑 PR 重新准入时，该 head 的加闸重任务一直被跳过而看似通过，合同未写 Owner 复核（2）；门口接受 `repo:o/n/**` 授权，请求不说明是哪个 PR、什么改动（3）；README 把加固的常驻 runner 当硬保证，job 留下的进程能活过清理（4）；`clued_release_tags.py` 与发布 `preflight` 运行的 `production-release-gate.mjs` 不受保护（5）。
      - NIT：未配 App 时复核静默通过，回退重跑可能选中复核自己的运行；m2 只比较 head，有秒级 ABA 窗口；README 对 `public-mcp-gate-receipt` 的描述不准；「只批这一次」的授权 24 小时后过期，未合并的 PR 会被打红。
    - 修复（Owner Decision `f2bf949a`：按路径一律复核）：
      - MAJOR-1/2、MINOR-1、MINOR-5：Owner 复核改为只按路径判定（§4.6）：`.github/**`、`scripts/ci/**`、`scripts/runner/**`、`apps/clued-cloud/scripts/**`、`apps/clued-cloud/package.json`、`package-lock.json`、`wrangler*.jsonc`、`supabase-public-config.ts`。逐行识别的结果只作摘要提示（`workflow_review_hint`）。任何 workflow 改动（包括加闸 workflow 的超时、matrix、触发器）都要 Owner 批准。
      - MINOR-2：合同 v29 §1.7 写明保护改动的做法：先提交、为该提交向 Owner 申请授权、批准后再推送；已被拒的 head 批准后编辑 PR 重新准入，其加闸任务未跑，要再提交（新授权）或关闭再重开一次 PR。
      - MINOR-3：门口只认精确写着该提交的授权，带通配的资源被拒；门口建的请求附上 PR 与改动路径（确认页显示为 Agent 说明，未核实）。
      - MINOR-4：README 第 6 步改为只有临时 runner 是硬保证；加固的常驻 runner 只是降低风险。
      - NIT：复核没有 App 私钥时报错，不再回退重跑；一份授权用于某提交后，到期不影响该提交，撤销才结束；`public-mcp-gate-receipt` 的描述更正；m2 的 ABA 窗口写入 §4.7。
    - PR #559 合并（2026-10-05，合并提交 `b1d45c3`，Owner Decisions `9dba872f`、`9c576817`：E2E 因 runner 启动本地 Supabase 超时取消，按当时状态合并）。
  - 复审 9（2026-10-05，对照 PR #559 head `2a8340f`）：fresh-context 只读评审，HOLD_FAIL（BLOCKER 0 / MAJOR 2 / MINOR 4 / NIT 4，Note `cc23e6e8`）。复审 8 的修复确认成立。
    - 新发现：
      - MAJOR-1：保护路径按准入那一刻相对 merge base 的文件列表判定，main 前进后不重新准入。分支历史先改到 main 的新版、再改回旧版，加上一个让 main 先吃进中间提交的空 PR，就能不经 Owner 把保护文件改回旧版。
      - MAJOR-2：合同 v29 让 Agent 先申请、批准后再推送，Owner 批准时看不到提交；门口写的说明也标「未核实」；这个动作还能和别的动作打包一次批准。
      - MINOR：发布 `preflight` 的 job 里，先跑不受保护的测试、后带凭据跑脚本，`verify-currentness-transport.mjs` 还把带凭据的环境交给不受保护的测试（1，已知项，文档低估）；`.gitattributes` 不受保护，可让准入脚本检出成别的编码而死锁（2）；确认页对这个动作仍提供通配等选项（3）；门口的传输错误在复核时把 check 打红（4）。
      - NIT：两处文档仍写无 App 私钥时重跑；工具说明未列这个动作；合同版本行后的空行与错误表；开关打开前门口已在为每个 head 开请求。
    - 修复（Task `d811ab16`）：
      - MAJOR-1：准入同时读 GitHub 的测试合并提交相对当前 base 的文件（`mergeDiffPaths`）判定保护路径；拿不到（未算出、冲突、比较不可用或 ≥300 个文件）时按需要 Owner 处理（`protected_path_unknown`）。每小时复核重读 PR，main 后来前进的情况一小时内拦下；建议 Owner 在 main ruleset 开「要求分支最新」彻底关掉这个窗口。
      - MAJOR-2：合同 v30 改为先推送，由准入检查开请求；门口写的说明附 compare 链接，确认页标为「准入检查说明」并给出链接（只有门口写的请求回执带 `origin: ci-admission`，Agent 不能伪造）；`repo.protected_change` 不能打包（迁移 `20261005140000_owner_review_hardening.sql`）。
      - MINOR-2：`.gitattributes`（任意目录）与 `.gitmodules` 受保护。MINOR-3：确认页对这个动作只给出精确提交一个选项。MINOR-4：门口 5xx/429/网络错误记为 `transient`；复核遇到它不发失败 check，记为复核错误。
      - NIT：文档更正；`clued_owner_request` 工具说明列出该动作与写法；合同版本行后的空行补回、错误表加 `owner_review_*`；开关打开前不再调用门口，摘要只说明需要 Owner。
      - MINOR-1：按评审的定性只改文档（§4.7），发布流水线未改。
  - 复审 10（2026-10-05，对照 PR #561 head `a52bb86`）：fresh-context 只读评审，HOLD_FAIL（BLOCKER 0 / MAJOR 3 / MINOR 3 / NIT 3，Note `883b07d1`）。复审 9 的 MINOR-2、MINOR-4、禁止打包、开关前不调门口属实。
    - 新发现：
      - MAJOR-1：合并差异比较 `pr.base.sha...merge_commit_sha`，不核对合并提交的父提交，`mergeable` 为空时也用；base 落后时混入 main 后来的改动，既误报也可能漏报。
      - MAJOR-2：授权只绑 head，不绑合并结果；Owner 批准 head 后，main 吃进中间提交，同一 head 的合并结果会把保护文件改回旧版，而门口对同 head 回放授权。
      - MAJOR-3：Owner 还没标 `ci-admission` 时，任何 Binding 都能调门口，写出确认页显示为「准入检查说明」的请求，附一个无害的比较链接；页面也不核对链接里的提交。
      - MINOR：说明里的文件名由 PR 控制、只列前 30 条（1）；Agent 仍能自建这个动作的请求，工具说明与合同矛盾（2）；合并提交未算出或冲突时直接要 Owner（3）。NIT：§4.6 清单与「未核实」措辞；确认步骤服务端仍接受通配；复核的瞬时错误判断偏窄。
    - 修复（Owner Decision `5a3b4935`：改为「必须是最新」）：
      - MAJOR-1/2、MINOR-3：去掉合并差异。保护路径按 PR 文件与「base 分支当前 tip 对 head」的比较一起判定；有保护路径的 PR 必须包含当前 tip（`baseTipCompare`，否则 `protected_change_not_up_to_date`），在它合并的那一刻 main 没有再前进时，合并结果就是 Owner 批准的 head。main 有推送时复核 workflow 立即运行，把落后的这类 PR 打红；合入 main 后是新 head，需要新授权。
      - MAJOR-3：门口只认 Owner 已标出 `ci-admission` 的 Binding，标出之前谁都不能用（迁移 `20261005140000`）；确认页只在链接终点正是要批准的提交时显示链接。
      - MINOR-1：说明里的文件名只保留普通字符、只列前十条，其余计数，链接为准。MINOR-2：Agent 自建 `repo.protected_change` 请求被拒（`owner_request_action_door_only`），工具说明与合同 v30 同步。
      - NIT：清单补 `.gitattributes`、`.gitmodules`，「未核实」措辞更正；确认步骤服务端对这个动作只接受请求本身的资源；复核按 `owner_review.kind` 判断瞬时错误。
  - 复审 11（2026-10-05，对照 PR #561 head `12999b0`）：fresh-context 只读评审，**PASS_WITH_FINDINGS**（BLOCKER 0 / MAJOR 0 / MINOR 4 / NIT 5，Note `a2163c7d`）。新改动均按声称实现，未找到可用代码行支撑的新绕过或死锁。
    - 修正：合同 v30 去掉走不通的「再推一次」，只留批准后关闭再重开一次 PR（MINOR-1）；Owner 上线步骤按现状重写（MINOR-2）；迁移 `20261005140000` 把此前遗留的待确认 `repo.protected_change` 请求置为过期（MINOR-3）；「合并结果就是批准的 head」改为有条件的说法，§4.7 写清 Agent 掌握合并时机、只有「要求分支最新」能关闭（MINOR-4）。NIT：compare 链接改用当前 tip；读不到比较时的行为写准；错误表的 `transient` 来源与 `refused` 处理；`.npmrc` 受保护；拒绝原因与检查说明只带净化后的路径名；复核失败 check 在「需先合入 main」时给出对应做法；DB 用例恢复跨用户断言。
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
| L0 | `main` 合并 | GitHub ruleset required check `clued-work-admission` 与 App check `clued-admission-verified` | **是**（判定时） | 没有有效 claim 覆盖该 PR 的 head、base、变更文件集，就不能合并。判定在检查运行时成立，之后每小时复核一次（复审 7 MAJOR-1 起按 PR 复核）。PR 正文可以写别人的认领（§4.7）。改动保护路径等的 PR 还需该提交上的 Owner Grant（§4.6；Merge Admission 第 6 步起始终强制，此前须开启 `CLUED_OWNER_REVIEW_ENFORCE`） |
| L0 | 自托管 CI 重任务（加闸的 8 个：Information Flow E2E、Supabase migration/pgTAP（g4-database）、connection authorization 与 isolated-candidate、node22-install、public-mcp behavior／protocol、clued-components、design-refs） | workflow 首个 job `admission-gate`（GitHub 托管 runner，秒级）；runner 机器上的开工前检查（`scripts/runner/`，Owner 安装后） | **装上 runner 检查且使用临时（ephemeral）runner 时是**（复审 7 MAJOR-4、复审 8 MINOR-4：常驻 runner 上跑 PR 代码的 job 能关掉它或留下进程，加固只降低风险）；只靠 `admission-gate` 时否：在改过 workflow 的分支上手动触发或 push 可以跳过它（复审 N3） | 未被 claim 覆盖的 PR 不跑加闸的重任务；改了 workflow 的 PR 要有 clued-admission App 的准入 check；非 main 的 push、发往其他分支的 PR、workflow 与 main 不一致的手动触发在开工前被拒。不加闸的自托管短检查（`model-program-*`、`mps03-native-agent`、`multitrack-governance-projection`、`node-profile-policy`、`runner-budget-policy`、`gitleaks`、`trivy` 等）照常跑 PR 代码，有超时上限；`memory-publication-gate`（只对发往 main 的 PR）与 `public-mcp-gate-receipt`（`workflow_run`，main 的代码）每个 PR 事件跑一次，不需认领 |
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

**实现（仓库路径互斥到交付为止，2026-11-24，迁移 `20261124160000`）**：第 2 条只对未交付的认领生效。已有的那条认领一旦有有效的 head 授权（`authorize_head` 成功；`work_claim_head_authorizations_v1` 中属于该认领当前 `execution_epoch` 且 `revoked_at` 为空的行），它的仓库路径（裸路径与 `repo:` 资源）不再参与第 2 条的重叠判定，别的认领可以认领同一路径。交付之后两个 PR 是否相撞由 git 判（推送入口对 main 的 `git merge-tree`、GitHub、列车合成），语义是否相撞由合成结果上的必需检查判；按文件名排队在这一段只多出空等。不变的有：认领的 write_set 本身、准入的覆盖校验（4.6，PR 的全部改动路径仍须在 write_set 内）、第 1 条与第 3 条、机械文件豁免；非仓库资源（`storage:`、`record:` 及以后登记的种类）在认领整个存续期照旧互斥。判的是已有的那条：已交付的认领续期扩大 write_set 时，撞上别人未交付的认领照旧冲突。授权全部被撤销（含接管、交接导致的换代）后，路径互斥恢复。所以交付后不需要、也不应当收窄 write_set。

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
- **私有租约钥匙（Task `f165eb56`，Owner Decision `22b9bd9e`，设计 Note `3ad61f76`，迁移 `20261005190000_work_claims_lease_key.sql`，合同 v31）**：
  - 问题：持有者按 Binding 记，而认领的其他字段对同一用户的所有 Binding 可见，不能证明谁在干这份活。Host 重连换了 Binding（claude.ai 连接器重连即如此），正在干活的会话续期与释放都得到 `work_claim_not_holder`，只能等过期后接管。
  - `clued_work_claim`／`clued_work_takeover` 成功时在回答顶层返回一次 `lease_key`（`clued_lk_` 加 32 字节随机数的 64 位十六进制），库里只存 sha256。持有者的幂等重放返回新钥匙，旧钥匙作废；接管后被替换认领的钥匙清空；释放（completed／abandoned）清空。
  - `clued_work_renew`／`clued_work_release` 可带 `lease_key`：持有者 Binding 照旧；它对仍有效且有钥匙的认领带错钥匙，拒绝 `work_claim_lease_key_invalid`，对已结束的认领则照常回答状态拒绝（如 `work_claim_not_active`）。同一用户的另一个 Binding 带对钥匙可以续期（认领转到它名下，fence 不变，`holder_session_ref` 换成它报的会话，回答带 `transferred: true` 和一把新钥匙，出示的旧钥匙作废；回执写 `via_lease_key` 与 `transferred_from_binding`）或释放（不转移，回执写 `via_lease_key`）；没有或不对的钥匙仍是 `work_claim_not_holder`。转入走续期，所以照样需要新的 `progress_ref`，受续期次数与硬截止约束；用完时只能带钥匙释放再重新认领。转入方受每会话 3、每 Binding 10 个活认领上限约束；它若已有同一幂等键的认领，拒绝 `work_claim_idempotency_conflict`。
  - 认领记下签发它的 Binding（`issued_binding_id`）。认领转走后，签发方用原幂等键重放，返回 `work_claim_idempotency_spent`（带 `transferred: true`），不会另起一个认领（多份赛马里也不会多占一份）。
  - 已过期认领的哈希留在表里，无人能用（续期与释放都按状态拒绝），不另清理。
- **认领列表与 Owner 交接（Task `f165eb56` 第 2 个 PR，Owner Decision `22b9bd9e`、`4bcc424d`，迁移 `20261005200000_work_claims_owner_handover.sql`，合同 v32）**：
  - Agent 自报（Decision `4bcc424d` v2）：`holder_label`（一行人话：在做什么、哪台电脑，≤200 字；MCP 工具里认领与接管必填）、`holder_client`（Claude Code、Codex、ChatGPT…，≤80 字）、`holder_session_title`（客户端里的会话标题，≤200 字），均不含控制字符，认领、接管、续期可带，写入 `work_claim_view`。`holder_session_ref` 应为客户端真实会话 ID，拿不到就不填。Clued 不核实，页面标为 Agent 自报。
  - `/work-claims` 页面（Native，`clued_work_claims_owner_list_v1`，只认本人登录，只读）：每条认领一块，显示 Agent/客户端与连接名（`clued_agent_bindings.agent_name` 与 vendor）、会话标题与会话 ID（`session_…` 给出 `https://claude.ai/code/<ref>` 链接，客户端为 Codex 时附 `codex resume <id>`）、标签、任务标题 + Task ID + scope、认领 ID、领取时间、到期与剩余时间、最晚到期、续期次数/上限与最近进展、关联 PR、触发来源、改动范围、状态（有效/收尾中/已释放/已过期/被接管，过了到期时间但尚未写回的也显示为已过期）。可勾选查看最近 24 小时结束的认领（`ended_within_hours` 1–168）及其结束时间与结果。时间按北京时间显示。Task ID 链接到 `/tasks?id=<canonical Task id>` 的 Owner 只读详情页（Task `16e1539d`）：Native `clued_task_owner_detail_v1` 只返回本人名下的 Canonical 任务、关联 Decision/Note 及该任务当前与最近 24 小时结束的认领；详情标注 Currentness，历史或未知记录不形成执行授权。相关记录也按完整 Canonical ID 打开；迁移和生产发布状态以该 Task 的实际回执为准。
  - 交接两步（同多份模式）：`clued_work_claim_handover_confirmation_issue_v1` 对认领生成一次性确认（视图不含租约时钟，卡住的会话自己续期不会让确认失效）；`clued_work_claim_handover_v1` 把 fence 移到该 Task 全部 fence 之上、轮换钥匙并只返回这一次、`lease_key_required=true`、租约从现在起重计（不超过硬截止、不计续期次数），回执 `WORK_CLAIM_HANDOVER` 记新旧 fence、不记钥匙。重放第 2 步不再返回钥匙。
  - `lease_key_required` 之后，续期与释放都必须带当前钥匙，持有者 Binding 也一样（Owner 的所有 Claude Code 会话共用一个 Binding，只靠 Binding 判不出卡住的旧会话），否则 `work_claim_lease_key_required`。新会话用交接文字续期：同一 Binding 直接续上；另一个 Binding 则按第 1 个 PR 的规则转到它名下并换新钥匙。
  - 限制：认领 id 不变，PR 准入（`clued_work_verify`）仍按认领判，不区分新旧会话；存储写入出示 `work_claim` 时也不要求钥匙。交接只保证旧会话续不了期、释放不了。
  - 钥匙不出现在 `work_claim_view`、活跃列表、resume、冲突与拒绝回答、回执、事件或日志；比较的是哈希，不是钥匙。迁移前签发的认领没有钥匙，行为不变。
  - 不变的部分：同一 Binding 的会话之间仍按 Binding 判持有者（GenericWorkClaim §4.1，复审 7 m4），钥匙不改变这一点。
  - 上线顺序（Owner Decision `33ee2115`）：先合并 PR，再按发布工作流依次执行生产备份、迁移 `20261005200000`、发布 Worker（合同 v32）。迁移必须先于 Worker：`/work-claims` 页面与交接调用的三个 Native RPC 只在迁移后才存在。
  - 兼容：迁移后、Worker 发布前，旧 Worker（合同 v31）照常工作。自报列均可为空，`work_claim_self_report_v1` 对没送的字段返回空值；`holder_label` 必填只在 v32 的 MCP 工具入参里检查，数据库不要求。所以这段时间认领的标签为空，页面上显示为空。回滚只需回退 Worker；迁移新增的列与函数不影响 v31。

- **合并位（Task `f89eaf0a`，Owner Decision `0edf7889`，合同 v33 §1.7）**：`main` 要求 PR 合并前跟上最新 main，CI 跑到一半时别的会话一合并，这一轮就白跑了。2026-10-06 PR 571 因 575、576 插队连续重跑两轮。合并位是共享触发来源 `merge:<owner>/<name>:<branch>`：会话准备合并时，续期自己 PR 的认领，把它加进 `trigger_refs`；冲突检测（`work_claim_conflicts`，同账号所有 Binding、精确匹配）保证同一时间只有一个持有者。拿到合并位的会话同步 main、跑 CI、合并，然后立刻续期去掉它或释放认领；拿不到的等着重试，被拒的续期不计次数、不耗令牌。
  - **自己的计时（Owner Decision `2ea795e4`，迁移 `20261006120000`）**：合并位在最后一次拿到或续期后 45 分钟失效（profile `merge_slot_seconds`=2700，不超过认领租约），认领视图给出 `merge_slot_until`。冲突检测只算仍有效的合并位，多副本竞赛的副本之间也互相检查有效合并位（只看合并位，不看路径和其他引用）；续期时引用没变但带着合并位，也要对其他认领的有效合并位做一次检查，所以失效后被别人拿走的合并位，原持有者续期拿不回来。Owner 交接不刷新合并位。续期刷新合并位每次都算一次续期，计入认领的续期上限。
  - **归还合并位与结束 PR 绑定（迁移 `20261119001000`、`20261119140000`）**：`clued_work_merge_slot_return_v1` 只归还该 PR 所在仓库的合并位，归还时留下 `WORK_CLAIM_MERGE_SLOT_RETURNED` 回执，PR 绑定状态和认领保持原样；它不收任何结束参数，带 `github_state` 一律是输入错误。PR 绑定只按 GitHub 上这个 PR 的真实生命周期结束，事实只有 merged、closed 两个，来源只有三个，都写同一个内部函数：GitHub 合入或关闭未合入事件（webhook，`clued_work_pr_merged_event_v1`）、常驻对账报告（`clued_work_pr_lifecycle_report_v1`，仅 ci-admission）、列车 adopt（`clued_work_claim_adopt_v1`，已合入）。常驻每轮先以空报告取回该账号该仓库仍未结束（active/unknown）的绑定 PR 号 `tracked`，对其中 GitHub 已不再列为打开的 PR 逐个读取，把 merged（带合并提交）或 closed 报回；仍打开的不报，`state` 传 `open` 是输入错误。每条 `WORK_CLAIM_PR_TASK_FINISHED` 回执记来源 `metadata.source`（`webhook`、`reconcile`、`adopt`），来源为 `reconcile` 的条数就是 webhook 漏投的次数。结束绑定后，服务按 PR 结束规则判断是否释放认领；已合入的不被迟到的关闭覆盖。
  - **GitHub 强制**：准入运行另发一个 App 检查 `clued-merge-slot`（Merge Admission 第 6 步之前，准入为提示模式时不检查）：头提交已包含基础分支最新提交时，只有认领持有有效合并位才通过；没包含时通过（GitHub 本来就不让合并）；服务还不报 `merge_slot_until` 时通过并注明未检查。它不并进 `clued-admission-verified`，因为重型工作流的准入关卡看那个检查，恰好包含最新 main 的中间推送仍要跑 CI。每小时的复核对已通过但合并位已失效或已归还的头提交补发失败检查。拿合并位时 PR 已包含最新提交，就编辑 PR 正文重跑检查。
  - **上线顺序**：合并 → 备份 → 迁移 → Worker 发布（合同 v33）→ Owner 在 main 规则集里把 clued-admission App 的 `clued-merge-slot` 加为必需检查。加之前它只是提示。
  - **剩余限制**：检查结果是某一时刻的判断；合并位在两次复核之间失效或被归还，已通过的检查最多一小时后才转为失败；这段时间里能合并的只有已包含最新 main 的那一个 PR，别的 PR 都还要先合入 main，所以不会白跑 CI。账号里还没有标记 `ci-admission` 角色的 Binding 时，任何 Binding 都能调用归还接口（与 adopt 相同）。仓库管理员权限可以改规则集。
- **ci-admission 的移交、用途与生效时间（常驻执行器主备 C10，Task `bb13efb5`，Owner Decision `bd86149e`、`1c5d34fd`，迁移 `20261023010000`）**：每条角色记录有生效时间 `effective_at` 和用途 `purpose`。
  - 一条记录到了生效时间才放行它的 Binding。还没生效的记录照样算标过：`binding_role_admits_v1` 只有在这个用途一条未结束的记录都没有时，才对所有 Binding 开放。只认精确持有者的地方（受保护改动的 Grant 门、受保护的 verify、执行观测、CI 命令门）也都要求记录已生效。
  - `/bindings` 上标 `ci-admission` 要选用途：常驻节点（`resident-node`）、停车位（`parking`）或其他（`other`，例如 GitHub 环境 `clued-admission` 的连接）。常驻节点和其他在确认 5 分钟后生效；停车位永不生效，只占住这个用途。迁移前的记录用途为 `unspecified`，按常驻节点对待。
  - 已有活的常驻节点持有者（含 `unspecified`）时，再标常驻节点被拒绝（`binding_role_resident_holder_exists`）；标为其他的连接不挡常驻节点。停车位只有在另有一个停车位时才能取消（`binding_role_parking_protected`）。
  - 「移交 CI 准入」（Native 两步：`clued_binding_role_handover_confirmation_issue_v1`、`clued_binding_role_handover_v1`）在一个事务里结束 X 的记录，给 Y 一条 5 分钟后生效的常驻节点记录；停车位和其他持有者不动。X 必须持有且不是停车位；Y 必须有效、有 `context:read`、还没有 ci-admission。轮换连接时，记录带着生效时间和用途搬走。
  - **剩余限制**：
    - 用途是 Owner 的声明，服务端不核实；把常驻节点标成「其他」，就绕开了常驻节点之间的这条约束。
    - 轮换连接时，已生效的记录在新连接上也立即生效。若把轮换出的新 token 装到另一台节点上，旧节点在途的发布（准入后约 150 秒内）可能与新节点重叠。所以不要轮换当班节点的连接；要换，先移交到另一节点（设计 v0.4 §7.2）。

### 4.5 预算

复用 N4 模式：

- **每 Binding 并发 claim 上限**（默认 3）：一个失控 Host 不能把所有 Task 都占了。
  - **实现（2026-10-02，Owner Decision `533a5286`，迁移 `20261002060001`）**：改为每个会话（Agent 自报的 `holder_session_ref`）最多 3 个活认领、每个 Binding 合计最多 10 个。原因：Owner 的所有 Claude Code 会话共用一个 Binding，原来的「每 Binding 3 个」会让并行会话互相挤占。会话标识是自报的，所以保留 Binding 总上限兜底；没有 `holder_session_ref` 的认领单独算一组。拒绝时 `limit` 字段写明撞到的是哪个上限。
  - **实现（2026-11-22，Task `e642d087`，迁移 `20261122130000`）**：会话上限只数在手的认领。认领所属 Task 已有 CI 确认为 active 的 PR 绑定时不计入；持有者自己 authorize_head 写出的 `unknown` 仍计入。发放和接收交接两处口径相同。Binding 10 个的上限照旧数全部活认领。会话上限的拒绝回执多带 `delivered`（本会话已交付几条）。
  - **实现（2026-11-24，Task `e642d087`，迁移 `20261124190000`）**：“在手”的口径从“PR 绑定是 active”改为“PR 绑定开着”（`work_claim_pr_binding_open_v1`：active 或 unknown），推翻 11-22 那条“unknown 仍计入”。列车里非车头的 PR 跑不到 CI 第 1 段，绑定一直是 unknown，三辆车在途时会话就拿不到第四条认领（11-24 现场）。依据四条：会话标识是自报的，机制上的兜底是 Binding 10 个，改前改后不变、仍数全部活认领；库已凭持有者带 PR 号的 authorize_head 认定“已交付”（`20261112090000` 据此把租约钉到硬期限），会话名额凭同一件事，不引入新的信任；“绑定是否开着”只有 `work_claim_pr_binding_open_v1` 一个答案（`20261122090000`）；unknown 与 active 走同一个结束出口（webhook、常驻对账、列车 adopt，只认 GitHub 的 merged/closed）。发放、接收交接、lease key 移交续期三处同口径，lease key 移交的拒绝回执也带 `delivered`、`active_binding`。残余：持有者带一个不存在的 PR 号 authorize_head 时，这个 Task 的 PR 绑定一直开着。绑定挂在 Task 上（主键 user_id、repo_id、pr_number，`20261108161615`），认领释放或到期都不结束它；能结束它的只有 GitHub 的 merged/closed（`20261119140000`），常驻对账读这个号遇 404 就跳过，永远等不到。此后同一用户对这个 Task 的认领一开始就算已交付，不受 24 小时限制。号属于常驻不对账的仓库、或其实是 issue 时同样如此。上界仍是每 Binding 10 条活认领。
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
  - **实现（Owner Decision `36b50981`，Task `d95ee6ea`、`3576b29c`）**：claim 的 base_commit 比 PR 的 base 新时，检查摘要写 `base_behind_claim` 提示。GitHub compare 返回 404 时写 `claim_base_unknown` 提示。两条提示均不改变准入结论。base_commit 由 Agent 自报，这项比较无法识别认领错配。
- **Owner 在 GitHub 网页直接改文件开的 PR**（Owner Decision `36b50981`）：同样需要 claim，没有豁免。Agent 与 Owner 共用一个 GitHub 账号，CI 分不出是谁改的，豁免会被 Agent 用来绕过。做法：网页改动前让任一 Agent 为该 Task 建 claim，把 `Clued-Work-Claim: <claim_id>` 贴进 PR 正文；改正文会重跑检查。
- 范围扩张（变更文件超出 write_set）→ 失败，提示先 `clued_work_renew` 携带扩大的 write_set（扩大时重新做冲突判定）。
- 加入 ruleset required 列表后，这条和 gitleaks、trivy 一样是无过滤 check，不会出现"等不到"的问题。
- 同一 check 顺带输出一张汇总表：按本 PR 变更路径判定哪些路径过滤的 workflow **适用**、各自在当前 head 上的结论、哪些**不适用**。这就是 2026-10-01 根因审计第 4 项要的"始终返回结果的汇总检查"，不必另开一个。
- 自报 JSON、伪造签名不算：check 由 workflow 从 Clued 实时查询，Receipt 在 Clued 侧。**同名 check 未覆盖**：PR 可以新增一个同名 job，见下文「仍未覆盖」。
- **实现偏离（第 3 步，2026-10-01，PR #454）**：生产的 `/mcp` 由委托 OAuth provider 接管，只接受 OAuth access token，直接的 `clued_bnd_` Binding token 会被 401 拒绝；因此 CI 不走 MCP，而是直接调 Clued 数据库 PostgREST 的 `clued_work_verify_v1`（公开 publishable key + Binding token 的 SHA-256，由数据库 `resolve_binding` 鉴权；P0-4 2a 后按受控 `cv1:` 校验值解析。它与 Worker 共用 Binding 业务认证，但C1阶段2后的运输角色不同：该CI门口保留anon，Worker用专用GW JWT，不能互相借角色）。强制与否不跟随 `CLUED_WORK_CLAIMS_V1`，而是 Owner 的仓库变量 `CLUED_WORK_ADMISSION_ENFORCE=true`：未打开时 check 只做 advisory（有 claim 就把判定写进 summary，没有则报 NOT_ENFORCED，一律放行），避免迁移一应用就拦住所有 PR 而 Agent 还无法建 claim；打开后缺 trailer、REJECTED、RPC 缺失、token 被拒、传输错误一律 fail closed。Merge Admission 第 6 步（2026-10-09）删除了该变量的读取与 advisory 分支：此后始终 fail closed（合并准入策略自身只建议认领之处除外），回退手段改为 `frozen` 与 main ruleset 的 Owner 应急步骤。

- **实现（第 7 步评审修复，2026-10-01，Owner Decision `64d9b418`，Task `95a93218`／`21a77b34`）**：
  - 评审发现原 check 在 `pull_request` 事件下运行 PR 自带的 workflow 与脚本，PR 可以改写判定。现改为 `pull_request_target`：workflow 与 `scripts/ci/clued-work-admission.mjs` 取自 base 分支，不 checkout、不执行 PR 代码，PR 只经 API 读取，每次运行重新读取，因此修改正文（`edited`）或重跑都看到当前 trailer 与 head。没有 `pull_request` 触发：改动本 workflow 文件的 PR 也由 base 分支上的版本判定。（复审 7 MAJOR-3：这只保证 PR 改不了对它自己的判定；PR 合并后，它的改动就是之后所有 PR 的判定代码，所以改动准入本身要 Owner 复核，见下。）
  - 每次 verify 带 `pr_ref`（`owner/repo#n`）。第一个判定为 ADMITTED 的 PR 把 claim 绑定到自己（一条 `work_claim_bind_pr` 回执），之后其他 PR 引用同一 claim 返回 `claim_bound_to_other_pr`。这是 verify 唯一的写入，在 CI 持有的只读 Binding 下进行。接管或新 claim 从未绑定开始。
  - `clued-work-admission-reverify.yml` 每小时检查一次：对发往默认分支、非草稿、head 上最新的 `clued-admission-verified` App check 为成功的 PR 重新判定，claim 已过期、释放、被接管或绑定到别的 PR 时由 App 发一条失败 check（没有 App 私钥时复核报错，复审 8），使必需检查变红（复审 7 MAJOR-1；原先按 head 取最新一条准入运行，可被同 head 的另一个 PR 或一次取消的运行废掉）。判定过期的窗口因此不超过约一小时（复核 job 失败时除外，会显示为失败的定时运行），合并时并不实时重验。被挡住的 PR 在认领恢复后推一个提交或编辑 PR 即重新准入。
  - PR 文件列表少于 `changed_files`（API 3000 文件上限）时强制模式判 REJECTED（`changed_files_truncated`）。
  - **仍未覆盖**：
    - PR 可以新增另一个 workflow，其 job 也叫 `clued-work-admission`，两者都是 GitHub Actions 的 check run。**处理（Owner Decision `37e01bb1`，2026-10-02）**：仓库属个人账号且私有，没有组织 required workflows。准入 workflow 在判定后用 Owner 的专用 GitHub App 再发一个 `clued-admission-verified` check（`--mode app-check`，App 私钥只在 `clued-admission` environment 中）。Owner 建好 App、在 main ruleset 把该 check 设为必需并限定来源为该 App 后，PR 无法冒充。App 未配置时这一步只提示、不发检查。
    - L0b 的 `admission-gate` 仍是 PR 定义的 job，PR 可以删掉 `needs:`。**处理（同一决定）**：准入检查读取 PR 新增或改动的 workflow：base 上已有闸的 workflow，或新加的含自托管 job 的 workflow，必须保留与 `GATE_JOB_SHA256` 一致的 `admission-gate` job，其余每个 job 都 `needs` 它，且 `if:` 为闸条件 `&&` 一个整体括号组；否则判 REJECTED（`workflow_gate:<文件>:<原因>`），PR 无法合入。闸 job 改为检出 base 分支（或默认分支）代码，PR 改脚本也绕不过。已知代价：被拒的 PR 上，重任务在拒绝前可能已经跑过一次。base 上已有、本来不加闸的轻量 workflow（Owner Decision `75abfe80`）不在检查范围。修改闸 job 本身需两步：先在 `GATE_JOB_SHA256` 中加入新摘要并合入，再改各 workflow。
    - 任何同仓 PR 的 workflow 都能引用仓库 secret，所以 `CLUED_CONTEXT_READ_TOKEN` 只能靠 environment 限定加轮换保护。
- **实现（token 隔离，2026-10-02，Task `95a93218`，PR #479）**：
  - `admission-gate` 不再调用 Clued，也不再拿 `CLUED_CONTEXT_READ_TOKEN`（它跑的是 PR 的代码）。它等待本 head 上 clued-admission App 的 `clued-admission-verified` check，只认本事件的 main 准入运行发出的、写着本 PR 的那条（该运行发出多条时看最新的），成功才放行（复审 2 N3c、复审 3 N-R1、复审 4 m1、复审 5 n1；原先看 `clued-work-admission.yml` 的 `pull_request_target` 运行的结论，现在运行列表只用来找本事件的准入运行）；重跑一律不放行（复审 3 N-R3）。强制模式下等不到运行、到期仍未结束（默认 480 秒）或 GitHub API 出错都不放行；advisory 模式从不拦截。来自 fork 的 PR 可能拿不到仓库变量，所以闸对 fork PR 一律按强制处理，只跟随准入运行的结果；准入运行在 base 仓库读变量，advisory 时总是成功（Task `27b4f5e8` 第 11 条，2026-10-02）。Merge Admission 第 6 步起闸与准入运行都不再读取该变量，没有 advisory 模式，任何 PR 都只跟随准入运行的结果。
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

- **实现（复审 7，2026-10-05，Owner Decision `b43f8b8a`，Task `c7b721ee`；复审 8 改为按路径，Owner Decision `f2bf949a`）：Owner 复核。**
  - 原因：ruleset 不要求审批，Agent 合并自己的 PR，准入放行的改动合并后就是 `main` 的代码，之后所有运行都按它执行。改掉守护生产的代码，守护就没了。
  - 需要 Owner 复核的改动只按路径判定（`protectedPathFindings`，改名前后的路径都算）：`.github/**`（所有 workflow 与 action）、`scripts/ci/**`（准入、发布授权、发布标签脚本与准入 job 自己跑的自测）、`scripts/runner/**`、`apps/clued-cloud/scripts/**`（带生产凭据运行的发布与核验脚本）、`apps/clued-cloud/package.json` 与 `package-lock.json`（这些脚本加载的依赖）、`apps/clued-cloud/wrangler*.jsonc`、`apps/clued-cloud/app/supabase-public-config.ts`（准入向哪个 Clued 查询）、任意目录的 `.gitattributes` 与 `.gitmodules`（复审 9）。
  - 复审 7 的逐行识别（environment、新 secret、自托管 workflow 的触发器）只写进摘要（`workflow_review_hint`），不再决定是否需要 Owner：它能被 YAML 转义、显式键、别名等写法躲过（复审 8 MAJOR-2）。
  - 做法：准入判定为 ADMITTED 后，用准入 Binding 调 Clued 的 `clued_owner_grant_admission_door_v1`，动作 `repo.protected_change`，资源 `repo:<owner>/<name>/<head 提交>`。有覆盖它的有效授权就放行（摘要写 `owner_review_granted`）；没有就开（或复用）一条待确认请求，判 REJECTED 并在原因里给出确认链接。Owner 在登录的 Clued 页面批准后，编辑 PR 或推提交即重新判定。
  - 只有资源里精确写着该提交的授权才放行，带通配的不算（复审 8 MINOR-3）。门口建的请求附上 PR、受保护路径数与 compare 链接（`agent_note`）；确认页把它标为「准入检查说明」（复审 9），其余请求的说明仍是「Agent 说明（未核实）」。
  - 一份授权对一个提交只用一次：第一次准入用掉一次并记 `OWNER_GRANT_USED`（`door: ci-admission`），之后同一提交的运行（复核、编辑 PR）凭这条记录放行，不再用次数；授权到期不影响已用过的提交，撤销后不再放行。「只批这一次」因此恰好覆盖一个提交。
  - 保护路径同时按 base 分支当前 tip 与 head 的比较判定；有保护路径的 PR 必须包含当前 tip，否则判 `protected_change_not_up_to_date`，不调用门口（复审 10，取代复审 9 的合并差异）。比较列出 ≥300 个文件时按需要 Owner 处理；读不到 tip 或比较时准入出错（不发成功 check），复核时 check 保持不变。main 有推送时复核立即运行。
  - 并入 main 沿用批准（Owner Decision `a0d93cd0`，合同 v34 §1.7）：head 只是把 main 并进已批准的 head 时，不再要新授权。`carriedApprovalSource` 从 head 沿第一父提交往回走，最多 10 步，每一步必须是两个父提交的合并、第二个父提交已在当前 tip 里（并入的是 main）。前一个 head 符合条件需要同时满足：自它以来的合并没有改动 head 相对 tip 改动的任何保护文件；main 在它与 tip 的合并基到 tip 之间也没改动这些文件。这样 head 相对 tip 的保护改动就是 Owner 批准过的那份改动。只问 `clued-admission-verified` 已通过的前一个 head，取走得最远的那个；门口仍是权威：它凭该提交的授权使用记录重新放行，授权撤销后不再放行。放行时摘要写 `owner_review_carried:<grant> from <提交>`。门口不放行（例如授权已撤销）时写 `owner_review_not_carried`，照常为新 head 开请求；门口传输错误判 `transient`。合并或 main 改了这些保护文件（如解冲突）、比较列出 ≥300 个文件或读取出错时，照常要新授权。「head 必须包含当前 tip」不变。
  - 流程（合同 v30 §1.7，复审 9 MAJOR-2）：先推送（包含当前 main）；准入检查拒绝并开请求，说明里有 PR 与 compare 链接，确认页标为「准入检查说明」；Owner 看过改动后批准；编辑 PR 重新准入；加闸任务在该 head 上已被跳过，需关闭再重开一次 PR 让它们运行（再推一次只会让新 head 重新被拒，复审 11 MINOR-1）。这个动作不能打包，确认页只给精确提交一个选项。
  - 强制开关打开之前不调用门口（不给 Owner 开请求），摘要只写明需要 Owner。门口的服务器错误记为 `transient`：准入时仍拒绝，每小时复核时不改动 check。
  - 只有 Owner 标了 `ci-admission` 的 Binding 能调这个门口，标出之前谁都不能用（复审 10 MAJOR-3），只需 `context:read`。Agent 不能自己开这个动作的请求（复审 10 MINOR-2）。确认页只在说明里的链接终点正是要批准的提交时显示链接。
  - 起初强制开关是 Owner 的仓库变量 `CLUED_OWNER_REVIEW_ENFORCE=true`：未打开时只在摘要里提示；打开后门口缺失、被拒或传输错误都判 REJECTED。Merge Admission 第 6 步（2026-10-09）起不再读取该变量，始终如打开时一样判定。

**L0b：重任务 workflow 的 `admission-gate` job**

- `information-flow-e2e.yml`、`clued-g4-database.yml`、`clued-cloud-node22-install.yml`、`clued-connection-authorization.yml`、`public-mcp-behavior.yml`、`public-mcp-protocol.yml`、`clued-components.yml`、`design-refs.yml`、`clued-cloud-quality-gate.yml`（2026-10-07 起，Task 5077b641；与 `scripts/ci/clued-work-admission.test.mjs` 钉住的九个加闸 workflow 一致）这些自托管重任务加一个前置 job，与 L0a 同一脚本；`needs: admission-gate` 且 `if: needs.admission-gate.outputs.admitted == 'true'`。
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
- **发布前 trailer 检查（2026-10-23，Owner Decision `349f6e42` 第 2a 项，hook 1.1.8）**：「发布」类调用（`git push`、`gh pr create`、改正文的 `gh pr edit`，以及上述 GitHub PR／推文件工具）之前，PreToolUse 在本地按 CI 第 1 段 `parseClaimReference` 的读法检查：被推送分支的 head 提交说明（`git log -1 --format=%B`，同一命令里先 `git commit -m` 的读该说明）和 `--body`／`--body-file` 正文都要有 `Clued-Work-Claim: <id>`，且点名的是本 checkout 记录的认领；该认领在项目里时还要有 `Clued-Work-Scope: project:<id>`；该认领须为 ACTIVE 或 DRAINING，且按本机时钟未过期。每个发现在每个会话拦一次，stderr 写明缺哪一行和要加的原文。只调用本地 git、不发网络请求；要运行命令才知道的内容（变量展开、编辑器、同一命令先写的文件、merge 等移动 HEAD 之后的 push）不猜，直接放行。起因是 PR #912 正文缺 Scope 行被第 1 段按 global 拒绝，并用掉同一 head 每 24 小时 2 次的放回额度（note `3d28423c`）。

**P0-4认证与运输边界（随ERRATA-005最终接受及实际阶段2生效）：** CI/钩子仍只提交 Binding 令牌的SHA-256证明值，不提交已存`cv1:`校验值；其独立anon直连集合须与当时`scripts/ci/**`及`scripts/hooks/**`实际调用的精确RPC签名一致，当前为8项。Worker80中仅`clued_work_verify_v1(text,jsonb)`、`clued_work_claims_active_v1(text,jsonb)`与该集合重叠；重叠不使其他Worker RPC可被CI直调，G6不在CI集合。Worker认领工具经GW运输仍须原Binding、Task/fence、write_set、lease、预算及准入校验；Native Owner批准仍须直接人类会话。凭据内部proof映射只支持原事务内的Binding校验，不产生GW身份、Owner批准或合并位。未知签名、角色或ACL漂移拒绝；阶段1不得提前声称anon面已关闭。不得借本说明改变门口、runner、FIFO、重跑额度、审批消费或Owner复核规则。

### 4.7 不保护什么（必须原样写进任何完成声明）

- Host 在第一次调用 Clued 之前消耗的模型 token。
- 在 Host 本机运行的 install／build／test（除 Claude Code + hook 未关闭的情况）。
- 不调用 Clued、不开 PR 的工作（它们也不会消耗共享资源）。
- Owner 临时禁用 ruleset 期间的合并。
- `main` 上未经人审的代码（复审 7 MAJOR-3）：ruleset 不要求审批，Agent 合并自己的 PR。Owner 复核（§4.6）只覆盖其中列出的路径。不覆盖：Worker 与应用源码（`apps/clued-cloud/worker/**`、`app/**` 等），它们被构建并部署（部署要 Owner 对该提交的发布授权），也被带凭据的测试与脚本间接加载；发布 workflow 在授权步骤之前的检查与 `preflight` 模式会带着数据库凭据运行 `apps/clued-cloud/scripts/` 下的脚本与其依赖（这些路径受保护，但脚本加载的其他源码不受保护）。Owner 复核开关打开之前，以上所有改动都不需要 Owner。
- Owner 复核的信任根是 Clued 数据库里的门口函数与授权表（复审 9）。Agent 仍有生产 Supabase 的写权限（OwnerCredential §9），能直接改这些函数或插入授权，让门口永远放行；在 Owner 把 Agent 的数据库连接改为只读之前，这一层只防合规 Agent 与仓库内的改动。
- 发布 workflow 的 `preflight` 与部署后核验（复审 9 MINOR-1）：同一个 job 先运行不受保护的测试（`apps/clued-cloud/tests/**`）与 typecheck，之后的步骤带着生产数据库凭据运行受保护的脚本；前面的测试可以改写磁盘上的这些脚本或 `node_modules`。`verify-currentness-transport.mjs` 还把带凭据的完整环境交给它列出的测试（与它们 import 的 Worker 源码），这些都不在保护路径内。`preflight` 不需要 Owner 授权。也就是说，只要一个 PR 合并并有人在 main 上触发 `preflight` 或部署后核验，就能拿到生产数据库凭据。修法是把这些测试放到不带凭据的另一个 job，或把它们与其 import 的源码纳入保护路径；目前只写明。
- main 移动后（复审 9、10、11）：有保护路径的 PR 必须包含当前 main，main 有推送时复核 workflow 立即重判并打红落后的 PR。但在复核跑完之前（几分钟），PR 的 check 仍是绿的，而合并时机完全由 Agent 掌握：两个在判定时都不含保护路径、都不需要 Owner 的 PR，由 Agent 用 API 接连合并，就能把保护文件改回旧版（复审 9 MAJOR-1 的原手法，复审 11 本地演示过）。这只能由 Owner 在 main ruleset 打开「要求分支最新」关闭；打开之前，「合并结果就是批准的 head」只在合并时 main 没有前进时成立。
- 准入读 head 与文件列表之间的 ABA（复审 8 NIT）：判定后再读一次 head，只比较 SHA。Agent 在几秒内把 head 推走再推回，判定可能用到另一个提交的文件列表。
- 仓库级 secret 与 GitHub 托管 runner 分钟（复审 7 m5）：任何能推分支的 Agent 都能加一个 `on: push`（任意分支）的托管 workflow，最多 256 份 matrix、每份 6 小时，读取所有仓库级 secret（例如 `OPENAI_API_KEY`、`CI_HEALTH_GITHUB_TOKEN`、`CLUED_E2E_EMAIL` / `CLUED_E2E_PASSWORD`）。准入、gate、runner 检查都不经过。生产相关的 secret 应放在只限 `main` 的 environment（`clued-release`、`clued-admission`）里；`CLUED_RELEASE_TAG_TOKEN` 的 job 已进 `clued-release`，secret 由 Owner 移入。`CLUED_PRODUCTION_BACKUP_KEY`、`CLUED_STORAGE_SOURCE_*` 是否只在 environment 中，从仓库无法核验。
- Agent 的 GitHub 凭据（复审 7 m7）：Agent 用 Owner 的 GitHub 身份，即仓库管理员（`docs/maintenance/main-admission-self-test-deadlock.md`）。持有管理权限的凭据能改 ruleset、`CLUED_MERGE_ADMISSION_STATE`、`CLUED_RELEASE_GRANT_ENFORCE` 等变量（Merge Admission 第 6 步之前还有 `CLUED_WORK_ADMISSION_ENFORCE`、`CLUED_OWNER_REVIEW_ENFORCE`）、environment 的分支策略与 secret，本设计的所有 GitHub 侧保证都以 Agent 不这样做为前提。要去掉这个前提，Agent 需要一个没有 Administration、Secrets、Variables、Environments 权限的凭据（例如只有 Contents 与 Pull requests 写权限的 GitHub App 或细粒度 token）。
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

### 交接后继候选（Task617 / Task7e922；2026-10-12）

本后继仍是未发布候选，不将前文历史生产状态扩展为本后继已验收。Owner Decision `c0e9b0f0` 选择完整旧会话防护，`9f4103bd` 要求服务自由交接与默认开启开关。公开 session/fence、消息或上下文读取都不能代替私有持有证明。

- 服务交换复用既有 GW80 `clued_work_renew_v1`：接收方准备并私留接收凭证，持有方以当前私钥发起，接收方接受。只协调公开请求 ID；双方钥匙不传消息、不进 Canonical。Scope、两 Binding 的当前权限、精确 Task/claim/fence/epoch/资源、撤销、期限、配额和赛马状态重验。Native Owner 默认 On 设置是独立 CAS；Off 禁新交换，已接受操作仅可用其私有原证明完成/恢复。
- 服务以独立 execution epoch 和 HANDOVER_PENDING 撤销全部历史 head、外部 App checks、auto-merge、旧 PR/dispatch 任务及未解决 publication。可信默认分支 CI 先开 publication 票据再发绿，迟到结果必须反向撤销；不能用“已请求取消”冒充任务已停止。撤销不可确认时不 ACK、不交付新钥匙。普通续期不改变 epoch，受保护 Task 的后继认领不恢复共享 Binding 的无钥匙入口。
- 异步 storage submit 固化服务器 epoch/请求摘要/资源；未携 claim 的新 submit 也固化已检查资源，执行时重验碰撞。load、begin、provider_attempt 与交接共享锁序，并重验声明 Task 当前性。强制模式下，历史无固化证明的 job 拒绝新 load/begin/provider_attempt，不回填虚构授权。旧 queued 零新副作用；已尝试的操作只复核原 journal，原完整验证结果仍可纯结算，无重复 POST、替换 writer 或新许可。激活前须盘点旧在途任务的拒绝/恢复处置并核实全部消费端。
- 撤销者通过现行 CI8 的受保护 `revocations_contexts` 发现 durable pending outbox/open publication 对应的当前授权 Scope，不依赖 claim 仍为 ACTIVE；Scope 与两类票据均使用有界游标，截断不当成已排清。ACK 与 publication begin/finish/reconcile/abort 变更原子写不可变审计 Receipt；精确 check 身份和原回执重放不改变。公开观察分支不提供这些能力。
- 保持公开函数集合 GW80/CI8。CI8 `clued_work_verify_v1` 的新 `execution_current` 分支仅作有界只读观察（`p_token_hash=null`、固定精确公开目标，无 Scope/Owner/claim DTO/私钥返回、无写入）；它只补充已合格 GitHub 门/独立 runner 的即时 epoch 观察，不产生执行准入。其他 CI 操作仍需现行 Owner 指定 CI Binding。须在精确源码审核中明确新观察 Caller 与全部负例资格，不能以函数数量相同代替审查。
- 分三阶段部署：①先合并并批准应用 staged SQL 与 Worker/页面/合同，旧模式兼容，自动交换仍 not-ready；②再合并并部署 CI publication/revoker、分支 gate 与独立 runner，验证真实消费和故障边界；③对精确源码和全部消费证据独立批准激活。新 RPC 未可用时不可将新强制 probe 投入分支门；页面 On 或单元绿色不代表完成。各 PR/生产迁移/发布/启用分别走现行门，保留实际 Receipt。
- 在使用 `work_claim_execution_activate_v1` 设置 `work_claim_execution_policy_v1.activated_at` 前，以 `CLUED_TEST_NATIVE_ACTIVE_ACTIVATION=1` 运行 `node scripts/ci/ci-required-selection.mjs --run source-v2-node`。启用验收中的扫描发布必须实际通过票据开始、建立进行中检查、重验、成功写入及读回、票据结算的顺序断言。常规 staged 验收将这条断言标为待完成。

每阶段部署必须固定已合并的真实 source commit，并使用配置 publisher 的独立输入：先获得该提交的只读 preflight 和已验证加密 backup；`migrate` 只指定本阶段实际审查的 migration 文件名，不隐含全部 pending migration，`deploy` 另走精确提交的发布门。保留两个动作各自的真实 Receipt，启动 workflow 不是完成证明。

消费端阶段的资格必须逐一覆盖实际独立安装的 runner 和所有可信 CI 发布路径；配置从 trusted default branch 读取，旧成功不替代即时 epoch，未知或不可达必须拒绝。原机器保护、只读 hook App 和 wrapper 不因安装而放宽，安装副本不会自动随 Git 更新。激活前须盘点已有 claim、旧未固化队列、历史 head、PR/dispatch 与未收口 publication；只发送取消请求不能作为停止证明，未查明外部效果的票据保持 open。激活是第三阶段单独精确 SQL/Owner 门，不能由开关 On、staged 服务已部署或候选测试绿色推导。

当前证据包括本机完整 TypeScript、隔离 PG/实际 cloud executor、Native UI 和 CI/runner 单元回归；正式 PR744 的准确 head 检查独立判断，生产、消费端安装与启用证据仍待完成。

- 全库只读扫描（2026-10-01，本会话委派的只读 agent）：MCP 工具目录 `apps/clued-cloud/worker/continuity.ts:1115-1415` 无 claim／lease／admit 工具；`lease_id`／`lease_expires_at` 列仅存在于 projection refresh job 表；kernel lease／budget 模块仅被 `evals/kernel-next/*` 引用；`.claude/settings.json` 仅 Stop hook。
- Projection Refresh 实现说明：`apps/clued-cloud/docs/model-program-m0/post-commit-projection-refresh.md`；精确 key 租约：`apps/clued-cloud/supabase/migrations/20260923213100_projection_refresh_exact_key_lease.sql`。
- N4 预算：`apps/clued-cloud/supabase/migrations/20260930200000_storage_read_budget_n4.sql`。
- execution_intent：`apps/clued-cloud/supabase/migrations/20260922143312_context_v2_execution_intent_identity.sql`。
- Kernel：`kernel/policy/approval-lease.mjs`、`kernel/domain/attempt-fsm.mjs`、`kernel/runtime/external-invocation-ledger.mjs`；`protocol/continuity/v1/profiles/execution.profile.json`（`runtime_selected=false`）。
- Git Connector 合同：`development/contracts/repository/GitConnectorWriteContract.v0.1.md`。
- WorkLease 候选：`artifacts/clued-validation/structure-freeze-prep/acceptance-20260907/step2/package-inputs/Clued_Phase2_结构准备设计_候选_v0.1.4_20260906.md` §4.2、§12。
- PR 事实：Clued Note `46f46fed-f464-487b-8c4d-ca97436ab140`；整合顺序 Decision `8b22f847-9a32-4ea7-8f8e-03654d0b1d6f`；暂停与豁免 Decision `93eb4e76-bc36-452b-9813-a521a5b648d3` v3。
