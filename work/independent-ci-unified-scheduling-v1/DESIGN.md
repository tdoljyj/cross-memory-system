# 统一调度阶段 2–5 · 落地设计与分阶段计划 r4（只是设计，不改代码）

- 日期：2026-11-01（UTC）
- KooYomi：项目 `0597aa60`；核心 Task `4972f2fa`（统一调度阶段 2–5）；相关 Task `25ac6c5f`（节点准备工具）、`5500739b`（节点可用性与一键接入）、`679a0c2b`（算力清单与看板）、`9cac75be`（两节点假设）、`c59e697c`（并行扫描）、`0c51fb42`（资源维护）。
- 依据的决定：`afec9be8`（两大目标）、`02e4374a`（路线顺序，本文是第 5 项）、`b4cd00c5`（v0.9 §13 九项）、`871a2b0d`（阶段 2–5 直接按 v0.9 实施）、`1ce9f800`（通用 runner 什么活都能干）、`dd33353d`（DESK 持钥做公司主节点）、`04463fcd`（托管免费分钟作溢出）、`e737a542`（受信档方向）、`183ee67c`（home-linux-01 退役、home-win-02 控制机）、常驻规则 `d6eef30e`（按任意多台节点设计）、费用规则 `325717a6` 与 Runner Runbook §2.4。
- 这份文档是什么：`871a2b0d` 定了阶段 2–5 不再逐阶段重写设计、直接按 v0.9（八轮审核）实施。v0.9 写于 10-23，那时还没有合并列车（§41，2a）、心跳与自动接班（2b）、节点登记导出工具。本文只做三件事：
  1. 把 v0.9 映射到 11-01 的真实代码和机器上，列出每处冲突和怎么解（§3、§4）；
  2. 把 `4972f2fa` 里写明“实施前须统一”的三处（当班、清扫水位、绿账）定下方案（§5）；
  3. 拆成可认领的任务，标出依赖和需要 Owner 拍板的点（§8、§9），并评估每台机器加入资源池缺什么（§7）。
  它不重新设计 v0.9 已定的东西（E1、签名链、JIT Worker、持钥范围、F-secret 不进池、N 主）。
- 限制：v0.9 原文（zip sha256 `d87a5811…`，md sha256 `543d2660…`）在资料中心，本会话没有存储连接，读不到原文。本文对 v0.9 的引用来自 Decision `b4cd00c5`、`da3dd87b` 和仓库里 `work/ci-scheduling-stage1-20261023/stage2-readiness.md`（它逐条引用了 v0.9 §3.4、§4、§7.2–§7.8、§9.2、§11.2、§12、§15）。§6 的阶段 5 内容和“N 主进入条件”是本文按这些来源归纳的，须对照 v0.9 §11.2 原文核对，见 §10 U1。
- 不改的东西：常驻执行器代码（`work/independent-ci-resident-v1/` 下的一切）、迁移、工作流、机器。并行会话正在改常驻升级通道（Task `018da927`），本文涉及常驻侧的改动全部排在它之后（§8.3）。
- 引用约定：`S1:n` = `apps/clued-cloud/supabase/migrations/20261023092957_ci_scheduling_stage1_v1.sql` 第 n 行；`Q:n` = `20261031060000_merge_train_queue_v1.sql`；`FO:n` = `20261031090000_merge_train_failover_v1.sql`；`H:n` = `20261023010000_ci_admission_handover_v1.sql`。

## 1. 结论先说

1. **实际只有两台物理机。** company-win-01、company-linux-01..04（以及 company-win-02 控制机）都是 DESK-W-591 上的 runner 注册；home-win-01、home-win-02（控制机）、home-linux-01（已退役）都在 TURING 上。所谓“每台机器都进池”，落到实处是：**DESK 和 TURING 各自变成一个多槽位节点**，原来那些常驻 GitHub runner 注册由节点代理按需开的一次性环境（E1/E4）和一次性 JIT runner 取代；以后新增的机器各自作为一个新节点加入。
2. **服务端已有骨架，但整条链路是“准备态”。** 生产库 `clued_private.ci_*` 19 张表都已建好；`ci_nodes_v1` 里只有 TURING 一行（`b24be772`，`state=pending`、`qualification_status=unverified`、未经 Owner 批准）；`ci_jobs_v1`、`ci_job_leases_v1`、`ci_green_ledger_v1`、`ci_train_lease_v1` 都是 0 行；资源池 `mode` 只能是 `prepared`、`phase` 只能是 1；签名传输一律返回 `SIGNATURE_GATEWAY_NOT_ACTIVATED`；没有任何节点能拿到运行资格。自动接班总开关 `ci_failover_settings_v1.enabled=false`。（2026-10-31 17:1xZ 只读查询）
3. **“什么活都能干”按 v0.9 分两层兑现：**执行层（扫描、F-pr 作业、构建测试）从阶段 2 起任何合格节点都能接；发布层（App 5368905 写六项必需检查、合并列车维护）是绑在密钥和角色上的职责，不绑机器，在持钥节点之间交接。阶段 2–3 发布层仍是“一个当班”（沿用 ci-admission 角色和 2b 自动接班），阶段 4 变成 N 主。
4. **当班的“唯一来源”必须是一个函数，不是一句约定。**服务端现在有几十个函数各自判断“是不是 ci-admission 持有者”（首轮清单 43 个，§5.1）。阶段 2A 先把它们全部改成调用同一个 `ci_duty_holder_v1`，阶段 4 切换时只改这一个函数的分支，才不会出现两套当班同时有效的窗口。
5. **最大的外部依赖是 Owner 侧开通：**单独 Cloudflare 账户上的 JIT Worker、只读监控 App、每台节点的 Owner 批准与钉住节点清单。这些 Agent 不能代做（§9 Q4）。
6. **阶段 2 的第一刀是服务端，不碰常驻代码：**统一当班入口、补“领下一个作业”“租约清扫”“第六项检查的发布键”、改准入校验使交接不作废在途作业、打开签名网关。这些可以和 Task `018da927` 并行。

## 2. 名词

| 名词 | 意思 |
| --- | --- |
| 节点 | 一台物理机（或以后一台独立 VM 宿主），在 `ci_nodes_v1` 里一行，有自己的身份密钥（P-256，优先 TPM）和加密密钥。 |
| 槽位 | 节点同时能跑的作业数，`profile.slot_count`（1–64）。 |
| 节点代理 | 每个节点上新装的常驻程序（v0.9 的 scheduler + 特权环境管理 + issuer + 非特权 fetcher），向服务端领作业、开 E1、收尾、签结果。和现有常驻执行器是两套程序，阶段 2–3 并存。 |
| E1 | 每个作业一个一次性 Hyper-V 虚拟机（Linux）；作业完即销毁。扫描在 E1 里再套 E3 加固容器。 |
| E4 | Windows Sandbox，Windows 作业的首选一次性环境。 |
| JIT runner | 一次性 GitHub Actions runner，注册凭据由 JIT Worker 按作业发放，跑完一个作业即注销。 |
| 发布者 | 持有 App 5368905 私钥、能写六项必需检查的节点。现在是 TURING 和 DESK（`dd33353d`），以后可以更多，本文一律写“所有发布者”。 |
| 当班 | 能做列车维护、合并位操作和（阶段 2–3）发布的那一个身份；由 `ci_duty_holder_v1` 判定（§5.1）。 |
| phase | `ci_quota_counters_v1` 中 `pool_policy.policy.phase`；本文规定 phase 数字等于统一调度阶段号（§5.4）。 |

## 3. 现状（11-01，只写和本设计有关的）

### 3.1 执行路径

一个 PR head 的路径（常驻 DESIGN §6、§10、§18、§41）：companion 每 60 秒发现 → 执行器排队 → 第 0 段打 bundle → 第 1 段工作准入（要求当班）→ ws-prep → 第 2/4/6 段在节点自己的 WSL 里跑 gitleaks、trivy、contract-placement → 第 3/5/7 段发布 → 第 8 段控制检查（含 merge-slot）→ 第 10/12 段列车维护与撤绿（目前影子模式）。全部在**当班节点一台机器上串行**完成，备机只读不跑。

另有一套和发布无关的 GitHub 通用 runner 池（`pool-general`）：DESK 上 company-win-01 和 company-linux-01..04（同一个 WSL `CluedCI-Linux`、同一个用户、同一个 Docker），TURING 上 home-win-01。它们跑 PR 代码，但“不是沙箱”（Runbook §2.2、§2.3），不能产出必需检查。

### 3.2 写死的“单活”假设

| # | 假设 | 位置 | 阶段 2–3 | 阶段 4 起 |
| --- | --- | --- | --- | --- |
| S1 | 同一时刻只有一个 `ci-admission` 持有者 | H:125-127、H:345-346；FO 看门狗只在恰有一个持有者时动作（FO:1053-1055） | 保留，经 `ci_duty_holder_v1` 读取 | 由列车租约持有者取代（§5.1） |
| S2 | 非当班节点 `schedule()` 一律 DEFERRED | `executor.mjs:500`、DESIGN §29.2 | 保留给发布段；执行段改由节点代理承担 | 取消（4E） |
| S3 | 每 tick 一个 Linux 独占区、每个 WSL 同时只有一个 clued-ci unit | DESIGN §18.1、§9 | 常驻执行器内部保留；扫描搬到 E1 后不再决定吞吐 | 同左 |
| S4 | executed-heads、烧头记录、每日额度按节点本地记 | DESIGN §16.1、§36 | 保留本地，服务端执行键 `resident_mirror:<node>`（S1:750） | 全池，`pool_enforced`（`b4cd00c5` 第 4 项） |
| S5 | 绿账在发布者本机 | DESIGN §19.2 | 本机权威 + 服务端旁路镜像（§5.3） | 服务端权威 |
| S6 | 列车运行、撤绿、清扫只在当班 | DESIGN §41.4、§41.6 | 保留 | 列车租约持有者 |
| S7 | 所有常驻节点同一 Source | DESIGN §41.6、§41.6a | 保留，并扩展到节点代理版本 | 保留 |
| S8 | 工作流 adopt/return/touch 用 TURING 的连接 aa4969fb | Task `9cac75be` A5 | 必须先修（当班是谁就由谁做） | — |
| S9 | 缺省节点名 `turing`、两节点测试夹具 | Task `9cac75be` A1–A3 | 必须先修 | — |
| S10 | 文档写“六项检查总是由 TURING 发布” | `docs/maintenance/independent-ci.md:9` | 随 `9cac75be` B 部分改 | — |

### 3.3 服务端骨架（阶段 1 + 2a + 2b）缺什么

已有：节点登记/批准/排空/退役/撤销的两步确认；按槽位、环境、内存、Source 匹配的租约（10 分钟，S1:675-708）；全局额度计数；发布键（每 repo+head+check+App 唯一，S1:113）；执行键（S1:118-129）；随机数；结果索引；节点间加密投递箱；列车租约与车头；绿账（带签名链列，但没人写，S1:156）；2b 的心跳、存活表、接班候选、每分钟看门狗。

缺口（阶段 2A/2B 必须补）：

| 缺口 | 后果 | 补法 |
| --- | --- | --- |
| G1 没有“领下一个作业”，`ci_job_lease_v1` 要调用方指定 job_id（S1:675）；作业上也没有“排除某节点”的字段（`requested_node_id` 只能指定一个节点，`exclusions` 是节点级的） | 节点无法拉取式调度；改派时无法避开原节点 | 新增 `ci_job_lease_next_v1(u,p,node)`：一个事务里按 §6.3 挑一个作业并租下，永不挑 `kind=maintenance`（列车请求须保持 queued，§5.1 第 3 步）；`ci_jobs_v1` 新增 `excluded_node_ids uuid[]` |
| G2 没有租约清扫，过期租约的作业不会回队（只有 release 会置 `expired`，S1:777） | 节点掉线时作业卡死 | pg_cron 每分钟 `ci_job_lease_sweep_v1`，规则见 §6.4 |
| G3 `qualify` 恒拒（S1:429），没有路径设置 `qualification_status=verified`、`eligible_until`、`hardening_observed` | 任何节点都不合格 | 签名网关上线后由节点签名的资格报告 + 钉住清单核对写入（2B） |
| G4 `mode` 恒为 `prepared`、`phase` 恒为 1（S1:266、S1:536） | 入队、租约、发布全拒 | Owner 两步确认的 phase 推进动作，每次 ±1（§5.4） |
| G5 心跳实际写在 `ci_node_liveness_v1`，`ci_nodes_v1` 三列心跳是死列；`ci_node_current_v1` 目前根本不看心跳（S1:560-571） | 资格核对不知道节点是否活着 | 定 `ci_node_liveness_v1` 为唯一存活来源；`ci_node_current_v1` **新增**存活新鲜度要求（这是新行为，不是换来源），死列加弃用注释 |
| G6 `preference`、`exclusions` 从未被读 | 偏好与排除无效 | 纳入 G1 的挑选规则 |
| G7 作业状态 observed/result_ready/publication_pending/invalidated 无人设置 | 结果与发布之间没有状态机 | 随结果登记、发布观察接线补齐（2B） |
| G8 发布键只允许 5 项检查（S1:107、S1:978），缺 `kooyumi-work-admission` | 第六项必需检查走不了池的发布路径，N 主无法完整发布 | 2A 扩 `check_name` 约束与 `ci_publish_prepare_v1` 白名单 |
| G9 准入校验要求“准入连接此刻持有 ci-admission”（`ci_claim_current_v1`，S1:603-606；2a 的孪生函数 `work_claim_execution_current_v1`，`20261012114500`:52），入队、租约、续租、开始、发布都调用它 | 任何一次当班交接都会作废交接前准入的全部在途作业；阶段 5 收掉兼容角色后所有准入失败 | 2A 对**所有作业类型**统一改为校验准入本身：① 签发时签发者是当班（阶段 4 起：是已批准发布者），这个判定在签发时写进准入行的新列，不靠事后查角色历史；② 签发者的连接此刻仍有效、未被撤销（保留 S1:603-604 现有检查，节点被撤销后其签发的准入立即失效）；③ 准入本身未撤销、认领仍有效。**调用者**的权限另由 `ci_publisher_current_v1` 与 `ci_duty_holder_v1` 判定。两个函数同样改。交接不改 `execution_epoch`，父子作业元组校验（S1:1015-1016）不受影响 |
| G10 续租要求进度摘要变化（S1:718） | 长时间无输出的步骤会续不上租 | 节点代理上报单调递增的进度计数（每次续租 +1），不依赖输出变化 |

## 4. v0.9 与现状的冲突及处理

| # | 冲突 | 处理 |
| --- | --- | --- |
| C1 | v0.9（`b4cd00c5` 第 7 项）“DESK-W-591 不持钥、2 台发布者是公司主节点和 TURING”；`stage2-readiness.md` 也写 DESK 不是 App 5368905 发布者 | 已被 `dd33353d` 取代：DESK 就是公司主节点，持自己的 App 5368905 私钥。本文以“发布者 = TURING + DESK（以后可更多）”为准；`stage2-readiness.md` 相应行与 `independent-ci.md:9` 按过时处理，T2E 顺手标注。 |
| C1b | 冲突 B（`stage2-readiness.md:54`）的前提是 DESK 不持钥；`dd33353d` 之后，App 5368905 私钥和跑 PR 代码的 E1 虚拟机在同一台宿主上 | 前提变了，风险还在且更大。T2E 的进入条件加“发布者边界隔离”：E1 管理用独立的非管理员 Windows 主体；私钥目录只有 `clued-control` 可读（现状，DESIGN §30.5），E1 管理主体与 VM 内一律不可读；E1 只挂内部虚拟交换机，不共享宿主目录；容量预留使 E1 不能挤掉常驻执行器；负向测试证明 E1 内与 E1 管理主体都读不到私钥、控制不了常驻服务。同一条件适用于所有发布者（TURING 在 T2G/3A 时同样要满足）。 |
| C2 | v0.9 第 8 项“只有硬化档能签扫描”，而 DESK 现在同时跑 5 个通用 runner、同一账户下 WSL 跑 PR 代码（`independent-ci.md:317` 要求专用机） | DESK 整机改造（T2E）就是为解这个。注意代码已在**所有阶段**强制：`delegated_scan` 只能租给 `hardening_observed` 且 `scan_signing_approved` 的节点（S1:693），结果登记同样核对（S1:1012）。所以池内扫描在阶段 2 只能由完成 T2E 的 DESK 承担；TURING 在 3B 硬化前不接池内扫描。改造完成前，扫描仍按今天的方式在当班常驻执行器内跑（v0.9 第 8 项过渡条款）。 |
| C3 | v0.9 第 5 项“托管 Windows 不作溢出” | 已被 `04463fcd` 修改：仅在免费分钟有余、自建 Windows 排队时承接不带密钥的 F-pr Windows 作业；阶段 4 落地。 |
| C4 | `4972f2fa` 验收 2 把 company-linux-01..04、company-win-01、home-win-01 当成各自独立的“机器” | 它们是两台宿主上的注册。本文把验收 2 读作“按物理宿主算”，需 Owner 确认（§9 Q6）。 |
| C5 | v0.9 的 Z2 加静默期写在阶段 1 的 `ci_train_lease_v1`；2a/2b 另以 ci-admission 角色为当班并做了心跳接班 | §5.1：阶段 2A 统一入口；阶段 2–3 只认 ci-admission；阶段 4 原子切到列车租约，2b 看门狗同时退场。 |
| C6 | 阶段 1 的心跳列与 2b 的存活表重复 | §5.2：只认 `ci_node_liveness_v1`。 |
| C7 | `stage2-readiness.md` 中阶段 2 的 Windows 退路是 home-win-01 on TURING | 保留；但 TURING 只有 16 GB 级内存（WSL 6 GB/3 CPU），同时还是发布者，home-win-01 只能是 1 槽、低优先级（§7）。 |

## 5. 三处统一（`4972f2fa` 前置项 3 的 a、b、c）

### 5.1 当班：一个判定函数

**现状的问题：**“谁是当班”今天由几十个函数各自判断（直接比 `role='ci-admission'`，或调用 `binding_role_admits_v1(…,'ci-admission')`、`merge_slot_admits_v1`），phase 不参与；阶段 1 的列车函数只看租约，又有一半不看 phase（`ci_train_request_v1`/`acquire_v1` 要求 phase ≥ 4，S1:1162、S1:1179；`renew/release/sweep_confirm/front_set` 不看，S1:1215-1300）。只“启用”列车租约，旧 ci-admission 持有者和新租约持有者会同时有效。

**首轮清单**（脚本按迁移顺序取每个函数的最后一个定义，筛出引用上述三种判定的，共 43 个；行号以所在迁移为准）。按职责分五类：

| 类 | 函数 | 阶段 ≤ 3 | 阶段 ≥ 4 |
| --- | --- | --- | --- |
| 甲 角色管理本身 | `binding_role_change_check_v1`、`binding_role_handover_check_v1`、`binding_role_handover_view_v1`、`binding_role_purpose_title_v1`、`binding_role_resident_held_v1`、`binding_role_start_v1`、`binding_role_view_v2`、`binding_role_title_v1`、`ci_admission_handover_patch_v1`、`binding_role_handover_core_v1`、`clued_binding_role_confirmation_issue_v1`、`clued_binding_role_handover_confirmation_issue_v1`、`clued_binding_role_handover_v1`、`clued_binding_roles_list_v1`、`clued_headless_binding_confirmation_issue_v1`、`owner_grant_resident_upgrade_door_v1`、`resident_upgrade_door_patch_v1`、`clued_merge_queue_ordering_set_v1` | 不变 | 不变（角色仍存在，只是不再等于当班） |
| 乙 列车当班 | `work_claim_ci_command_v1` 的角色闸（FO:672-676）及其后全部动作：`ci_nodes_status`、`train_sweep_watermark`、`merge_queue_keepalive`、`revocations_contexts`、`revocations_list`、`revocation_ack`；`ci_sweep_watermark_v1`；`work_claim_merge_queue_keepalive_v1`；`clued_work_claim_adopt_v1`、`clued_work_merge_slot_return_v1`、`clued_work_merge_slot_touch_v1`（经 `merge_slot_admits_v1`，Q:485-493）；角色探测 `clued_work_merge_slot_holders_v1`（`20261010112852`:172，决定常驻 ACTIVE/STANDBY，`executor.mjs:500`）；阶段 1 列车六函数 | `ci_duty_holder_v1` = ci-admission 持有者 | `ci_duty_holder_v1` = 列车租约持有者 |
| 丙 发布 | `ci_publisher_current_v1`（S1:925-931）；命令门 `publication_begin/abort/reconcile/finish`；`work_claim_independent_begin_v1`、`work_claim_independent_abort_v1`、`work_claim_independent_drain_command_v1`（`20261029050000`:104-106、172-174、250-252，常驻第 3/5/7 段的真实发布路径） | 当班 | 任何已批准、已硬化的发布者走阶段 1 预留路径（merge-slot 受服务端“一仓一绿”约束）；2a 路径的 merge-slot 发布由服务端拒绝（`phase_requires_reservation`），防止 phase 3 开始的批次在切换后经 2a 开出服务端看不见的绿；回退到 phase 3 时反之 |
| 丁 准入有效性 | `ci_claim_current_v1`（S1:603-606）；`work_claim_execution_current_v1`（`20261012114500`:52）；`clued_work_verify_v1`；准入签发门 `owner_grant_admission_request_v1`、`clued_owner_grant_admission_door_v1`、`owner_grant_admission_use_v1`、`clued_owner_grant_door_consume_v1`、`owner_review_hardening_patch_v1` | 签发时须是当班；之后按 G9 | 签发者须是已批准发布者；之后按 G9。多个发布者可能为同一 head 签发准入：head 授权与准入门计量（`work_claim_door_usage_v1`，单位为 head）去重，额度只计一次 |
| 戊 自动接班 | `ci_admission_failover_owner_v1`、`ci_failover_candidates_v1`、`ci_failover_change_view_v1`、`ci_failover_exclusion_v1`、`clued_resident_failover_v1` | 照常 | 退场（第 5 步） |
| 己 判定原语 | `binding_role_admits_v1(…,'ci-admission')`：账户下没有任何未撤销的 ci-admission 行时放行任何连接（`20261023010000`:65-66，失败即放开）。该函数带角色参数，也守发布门（`release-door`，`20261003200000`:391、`20261004200000`:391），以下限制只针对 `p_role='ci-admission'` | ci-admission 用法只作为 `ci_duty_holder_v1` 的内部实现，不再被别处直接调用；其他角色照旧 | 同左；阶段 5 收角色前，ci-admission 分支先改为失败即关闭（见 5D），发布门行为不变（加发布门回归测试） |

这份是首轮清单，T2A 的第一项交付是把它定稿：逐个读最后定义、确认归类，并加一个 CI 静态检查——迁移里新出现的直接 ci-admission 判定（只有甲类在白名单里；己类原语只允许 `ci_duty_holder_v1` 调用）一律失败。

**方案：**

1. **2A 新增 `ci_duty_holder_v1(u,p)`**，返回当前当班的节点与连接：
   - phase ≤ 3：唯一的、已生效、`purpose in ('resident-node','unspecified')` 的 ci-admission 持有者（与 FO:1053、Q:492 口径一致）；没有或多于一个则返回空。原先口径更宽的入口（如 `ci_publisher_current_v1` 只排除 parking，S1:929）在 phase ≤ 3 保留各自原口径，保证 2A 合入后 phase 1 下行为不变（回归测试覆盖）。
   - phase ≥ 4：`ci_train_lease_v1` 中 `state in ('active','sweep_required')` 且未过期的持有者。`sweep_required` 时允许：清扫、水位写入、撤绿与撤绿确认、保活（DESIGN §41.6“只撤和保活照跑”）；不允许：车头推进、新的 merge-slot 绿。
   - 账户到项目：2a 的入口只知道连接和账户。规定账户下有 `pool_policy` 行的项目即 CI 项目；多于一个则 `ci_duty_holder_v1` 返回空（关闭失败）。
2. **2A 把乙、丙、丁三类入口全部改为经它判定**（丙类 phase ≥ 4 分支、丁类签发判定另见上表与 G9）。2A 合入时 phase 仍是 1，对现有行为无变化，只有一处有意收紧：`clued_work_verify_v1` 今天判角色不看 `effective_at`（`20261011131755`:420、:450），交接目标在生效前就能签发准入；改走当班判定后要等生效。回归测试把这条列为预期变化。另一处预期变化：账户下没有任何 ci-admission 行时，`binding_role_admits_v1` 今天放行任何连接，`ci_duty_holder_v1` 则拒绝；CI 账户有角色行，实际无影响，同样列入回归测试。
3. **phase 3→4 切换（一个事务）：**
   - 前提（[机器]）：4E 已上线（常驻发布段已能走阶段 1 的预留路径，按 phase 自动切换，见 §5.3）；无进行中的交接；当前 ci-admission 持有者唯一、存活（≤ 20 分钟）、节点 `active` 且资格有效；**全仓库没有开着的绿**（列车先暂停进车，等在途绿合并或撤销；服务端依据是旁路镜像表中每个发布者的最新状态，再加切换前当班对 GitHub 的读回，两者都显示无开着的绿才放行）；已有专用列车维护认领（见下）；对账达标（Q2）。
   - **专用列车维护认领：**`ci_jobs_v1` 的认领、准入、head 授权都不能为空（S1:66-72），租约与续租的到期都受认领到期封顶（S1:1211、S1:1235-1236）。当班自己没有认领，切换时列车又已暂停，不能借某个 PR 的认领（PR 合并即失效）。所以 T4 事先建一个长期存在的专用 KooYomi 维护 Task 及其认领（以 main 当前提交为 head 授权），由当前列车维护者每次续租时一并续认领；当班交接或租约换手时，新持有者接手同一个认领（认领交接走 `clued_work_renew` 的交接动作）。正常的 `ci_train_acquire_v1`（阶段 4 内租约换手）也只用这个认领建请求。这个认领须满足 `ci_claim_current_v1` 的全部约束：固定的合成 `pr_ref`（认领 `bound_pr`、head 授权、准入三处一致，S1:588、S1:595-597、S1:601-602）；该 head 的准入门计量行（`CI_TASK_METER_REQUIRED`，S1:610-611）。认领交接会推进 fence/epoch，旧请求作业随即失效，新持有者必须新建请求作业（`ci_train_acquire_v1` 本来就要求），不得复用旧的。head 授权固定在建认领时即可，租约到期受认领到期封顶，不受 head 新旧影响。
   - **G1 不派维护作业：**列车请求作业必须一直保持 `queued`（`ci_train_request_current_v1`，S1:1149），`ci_job_lease_next_v1` 一律跳过 `kind=maintenance`，否则它会被租出，续租随即 `CI_TRAIN_REQUEST_INVALID`。
   - 动作：置账户级 2b 总开关为关；用专用维护认领在同一事务里建一条列车维护请求作业（`kind=maintenance`，`requested_node_id` = 当前持有者节点，绕过 `ci_train_request_v1` 的 phase 检查）；直接写入 `ci_train_lease_v1`：持有者 = 当前 ci-admission 持有者，`request_job_id` = 刚建的请求，`state=sweep_required`，新 generation，`expires_at` 取 min(现在 + 10 分钟、认领到期、节点 `eligible_until`、资格到期)（与 acquire 一致，S1:1210-1211）；最后置 `phase=4`。
   - 因为 `ci_duty_holder_v1` 在同一提交里改走租约分支，第一任租约持有者就是原当班，且服务端绿账与本机绿账在切换点都没有开着的绿，所以不存在两个当班来源、也不存在服务端看不见的绿。此后续租走正常的 `ci_train_renew_v1`（请求作业已在）。
4. **phase 4→3 回退（一个事务）：**把列车租约强制 `silence` 并清空持有者；若 ci-admission 持有者存活（≤ 20 分钟）且节点资格有效，它继续当班；否则在同一事务里把 ci-admission 交给刚才的租约持有者（按现有交接规则 5 分钟后生效，这 5 分钟无人当班，关闭失败、可接受）；`ci_duty_holder_v1` 回到 ci-admission 分支；新当班若不是原持有者，须先完成清扫才能首次发布（DESIGN §41.6）。回退同样要求无开着的绿，或由回退后的当班读回 GitHub 结算。
5. **2b 看门狗是按账户的**（`ci_failover_settings_v1` 主键 `user_id`，FO:200）：账户下任一项目 phase ≥ 4 时总开关必须为关（phase 推进动作强制关、开关设置动作拒绝打开）。
6. **测试：**3 节点、5 节点；静态检查；切换与回退事务前后乙、丙、丁类入口各自拒绝/放行；切换后旧 ci-admission 持有者（若不再是租约持有者）调用合并位、水位、撤绿、角色探测一律被拒或报 STANDBY；切换后第一次续租成功；回退落在已死持有者时自动交给租约持有者。

### 5.2 清扫水位：只留一处

- **唯一来源：`ci_sweep_watermark_v1`（2b，按连接 × 仓库，FO:185-196）。**它已经在线、已有调用者。节点与连接一一对应（每个连接最多一个在用节点，S1:59），按连接记等于按节点记。写入闸经 `ci_duty_holder_v1`，所以阶段 4 的新租约持有者能写。
- `ci_train_front_v1.sweep_watermark`：弃用。2A 加约束使其恒为 NULL，读它的代码改读 `ci_sweep_watermark_v1`。
- `ci_train_lease_v1.sweep_state/sweep_generation`：保留，只表示“新租约持有者是否已完成接手清扫”这一门状态（`sweep_required → active`），不存水位值。`ci_train_sweep_confirm_v1` 确认时读 `ci_sweep_watermark_v1` 中该持有者的行，要求其更新时间不早于租约取得时间。
- 存活来源同理：`ci_node_liveness_v1` 唯一（G5）。

### 5.3 绿账：本机权威 → 服务端权威

- **阶段 2–3 不用 `ci_green_ledger_v1`。**现有写入路径会变成活的闸门：`proposed` 只能由 `ci_publish_prepare_v1` 创建（S1:1047），而它要求一个有已开始租约的阶段 1 作业（S1:1023）、会建永久发布键（S1:287-291、S1:992）、并在服务端已有别的开着的绿时拒绝 merge-slot（`CI_OTHER_GREEN_EXISTS`，S1:1036-1040）；它的 `external_id` 是 `clued-ci:<keyid>`，与常驻执行器自己的检查运行对不上。所以“镜像”不能复用它。
- **2B 新增旁路镜像表 `ci_green_mirror_v1`**：只追加；每行是当班发布者签名的一条本机绿账变动（proposed/posted/revoke_requested/revoke_confirmed/merged，带本机日志序号与上一行哈希）；不建发布键、不影响发布，任何发布决策都不读它；唯一的读者是 phase 推进/回退事务的“无开着的绿”检查（且须另加 GitHub 读回，§5.1 第 3 步）。写失败只告警，不影响本机发布。
- **对账（3D）：**看板作业（`679a0c2b`）每天对每个发布者，把本机绿账与它在镜像表里的行逐条比对；差异写看板、告警、记 KooYomi。遍历“所有发布者”，不写死两台。
- **切换时点：**phase 3→4 的进入条件之一是对账零差异达到 Owner 定的天数（§9 Q2），且期间至少一次当班交接。
- **阶段 4 起：**服务端权威，顺序按阶段 1 的设计：先在服务端预留（`ci_publish_prepare_v1`，建发布键、写 `proposed`），再写 GitHub，再观察（`ci_publish_observe_v1`）并写本机日志；本机日志降为本地缓存。常驻执行器的发布段改用阶段 1 的预留路径和 `external_id`（`clued-ci:<keyid>`）——这是 4E，常驻侧改动，**必须在 phase 3→4 之前上线**：代码先暗装，按 `pool_policy.phase` 自动选路（phase ≤ 3 走现有 2a 路径并写旁路镜像，phase ≥ 4 走预留路径）。否则 phase 4 后常驻仍走 2a 路径，服务端 `CI_OTHER_GREEN_EXISTS`（S1:1036-1040）看不见它开的绿，两个绿就能并存。切换点另要求全仓库没有开着的绿（§5.1 第 3 步），所以不需要把旧绿导入服务端。
- 接受的残余（`b4cd00c5` 第 4 项原文）：KooYomi 数据库被攻破时两个绿可能并存，只能靠 GitHub 侧核对事后发现。

### 5.4 phase 与阶段号对齐

阶段 1 的代码只比较 `phase < 4` / `≥ 4`，别处没有读 `pool_policy.phase` 的代码（审核已核）。本文规定：`policy.phase` 的数值 = 统一调度阶段号（1–5），phase ≥ 2 时 `mode=active`。推进/回退动作每次 ±1，入参带期望的当前 phase（CAS），服务端在事务里核对进入条件中标 [机器] 的项，其余由 Owner 在确认页上逐项勾选，勾选内容写进回执。

## 6. 分阶段设计

每个阶段写：目标、内容、进入条件、退出验收。所有生产迁移、Worker 发布、机器安装、App/账户/密钥/规则集改动，照 `871a2b0d` 每步另请 Owner 授权；所有代码独立审核、六项必需检查、经 PR 合入。

### 6.1 阶段 2：服务端调度接通 + DESK 整机改造

**目标：**池里第一次有合格节点从服务端领作业，在 E1 里跑完、结果签名写回；发布仍由当班完成。DESK 上原有 5 个常驻 GitHub runner 注册退役。

**内容：**

- **2A 服务端统一迁移**（不碰常驻）：§5.1 的 `ci_duty_holder_v1` 与全部入口改造；§5.2；G1、G2、G4、G5、G6、G8、G9；可用时段 `availability` 进 profile 白名单（`5500739b` 内容 2），挑选时检查。测试含 3、5 节点用例（`d6eef30e`）和“phase 1 下行为不变”回归。
- **2B 签名网关**：把 `worker/ci-scheduling-v1.ts` 接进路由，实现原子的“数据库上下文 + 随机数”契约（S1 README 要求单独审核）；节点资格报告：节点签名的资格清单 + 钉住清单核对后写 `qualification_status=verified`、`eligible_until`（7 天，到期重报）、`hardening_observed`；G7 状态机；G10 进度计数；§5.3 的旁路镜像表与写入命令。
- **2C 节点代理与 E1-Linux**：新目录 `work/independent-ci-node-agent-v1/`（不在常驻目录里）。四个进程按 v0.9：scheduler（拉作业、续租、上报）、特权环境管理（Hyper-V VM 创建/启动/停止/删除，签名收尾链：每个作业证书绑定上一个作业的销毁证明）、issuer（用节点身份密钥签结果）、非特权 fetcher（只取 git 对象）。E1 镜像固定哈希、不可写回；作业结束即删 VM。复用 `stage2-readiness.md` 列出的原型代码中可复用部分。槽位数由 2C 实测决定（§7、U3），首装每节点 1 个，实测后按内存与盘调整，调整时告知 Owner。
- **2D JIT runner 与每作业钩子**：Owner 在单独 Cloudflare 账户上开 Worker（`b4cd00c5` 第 6 项），Worker 自带钉住清单，用 TPM 挑战核对节点后按作业发 JIT 配置；每作业钩子 1 小时限权令牌。只读监控 App 另建。
- **2E DESK 改造**：只读盘点（Hyper-V、TPM、网络代理、主体与服务，`stage2-readiness.md` 请求 1）→ 满足 C1b 的发布者边界隔离 → 节点代理安装 → DESK 节点登记、Owner 两步批准、钉进所有发布者的已批准节点清单 → E1 与 JIT 跑通 → 再排空并注销 company-linux-01..04、company-win-01，退役 `CluedCI-Linux` 和容量看门狗（顺序：先有替代容量，后注销）；Windows 作业先测 E4，不行按 §9 Q3 处理；PR880 的宿主资格工作流先换承载者（`stage2-readiness.md` 冲突 A）。完成后 DESK `hardening_observed=true`、可以签池内扫描。
- **2F 扫描进池**：当班把三个扫描作为 `delegated_scan` 子作业入队，由已硬化且批准签扫描的节点（阶段 2 只有 DESK）在 E1/E3 里跑，结果签名后经投递箱交回当班，当班照现有顺序发布。这是 `c59e697c` 的“任意多台分摊扫描”那一半，要改常驻执行器。
- **2G TURING 执行能力**：为了改派实测需要第二个能接执行作业的节点。TURING 先装节点代理的执行部分（1 个 E1 槽），满足 C1b，不改发布、不硬化（所以不接池内扫描）。

**进入条件：**阶段 1 已合入（已满足）；[机器] 所有发布者都已登记且存活；`9cac75be` A1–A5 已随安装波上线；`018da927` 合入（只约束 2F）；Owner 已开通 JIT Worker 账户（只约束 2D）。

**退出验收（对应 `4972f2fa` 验收 2、3、4 的阶段 2 部分）：**

1. DESK 节点从池里领到至少一个真实 Linux 作业和一个扫描子作业，在 E1 里完成，结果由节点签名、经当班用 App 5368905 写回。
2. 留痕负向测试：作业 A 在 E1 里写一个文件和一个假凭据，同节点下一个作业 B 读不到；VM 销毁有签名证明。发布者边界负向测试（C1b）通过。
3. 改派：一个节点跑作业时人为断网，租约过期后（≤ 10 分钟 + 1 分钟清扫）作业按 §6.4 回队，被另一节点领走完成；没有重复发布。
4. 一次手动当班交接后，交接前已入队、已租出的执行作业照常完成（G9），新当班照常发布。
5. GitHub 上 company-linux-01..04、company-win-01 已注销，`CluedCI-Linux` 已退役；`679a0c2b` 面板显示为“已退役”。
6. 零新增费用；Windows VM 许可评估结论成文（E4 包含在 Windows 11 Pro 内；E1-Windows 未经 $0 许可核实不得实施）。

### 6.2 阶段 3：所有发布者硬化、备机兼中转、对账

**目标：**所有发布者都成为硬化档节点、都能接包括扫描在内的任何执行作业；不当班的发布者承担扫描与中转；为阶段 4 积累对账天数；F-secret 受信档完成细化设计。

**内容：**

- 3A 其余发布者（现为 TURING）补齐节点代理的发布侧与硬化前置；home-win-01 若在阶段 2 充当 Windows 退路，此时按 `b4cd00c5` 第 5 项另找一台不签任何东西的机器，没有就放回 DESK。
- 3B 硬化档：发布者上不再有任何跑 PR 代码的常驻注册；每次心跳与每次扫描开始复查服务和发行版清单（`stage2-readiness.md` “DESK hardening”行）；`hardening_observed` 由节点签名报告写入；Owner 批准 `scan_signing_approved`。
- 3C 备机兼中转：不当班的发布者承担托管转发（第 R 段）与池内扫描；改主备 v0.4 §5.2、§8.5（`b4cd00c5` 第 4 项）。
- 3D 旁路镜像全量写入 + 每日对账上线（§5.3）。
- 3E 受信档细化设计（`e737a542`）：在持钥的公司主节点上单独 VM/账户，只接 main 与受保护环境的带密钥作业；灾备 App 私钥是否进入，单列 Owner 决定。只设计、审核，实施放阶段 5 且另行授权。

**进入条件：**阶段 2 退出验收全部通过；[机器] phase=2 已运行 ≥ 3 天且期间无未结 UNKNOWN 发布。

**退出验收：**所有发布者 `hardening_observed=true` 且都经池领过扫描子作业；一次当班交接后，旧当班继续接执行作业、新当班照常发布；对账已连续运行且结果入看板。

### 6.3 调度规则（阶段 2 起一直适用）

拉取式：节点有空槽才来领，服务端在一个事务里挑：

1. 过滤：节点 `state=active`、资格有效、存活新鲜（≤ 20 分钟，与 2b 候选口径一致，FO:957）、在可用时段内；作业 `required_environment` ∈ 节点 `environment_kinds`；`required_memory_mb` ≤ 节点上限；作业要求的能力 ⊆ 节点能力且不在 `exclusions`；作业 `source_sha` = 节点 `qualification_source`；`delegated_scan` 只给 `hardening_observed` 且 `scan_signing_approved` 的节点（S1:693，所有阶段）；`requested_node_id` 不为空时只给该节点。
2. 排序：`priority`（0 最高）→ 车头批次优先（与 `work_claim_merge_rank_v1` 一致，车头身份以 2a 为唯一来源）→ 入队时间。
3. 节点偏好：`preference=primary` 的节点先领；`relay`、`overflow` 节点只领已排队 ≥ 60 秒的作业。
4. 额度：全局额度在租约时原子检查（S1 已实现）；阶段 4 前 executed-heads 与每日上限仍由发布者本机执行。

### 6.4 改派与不重复

阶段 1 的键语义决定了能改派到什么程度：

- 只有 `kind=combination_execution` 在开始时写执行键（S1:742-753）：`combination_mode=depth1`（列默认值，S1:73）写头执行键，唯一索引 (仓库, head, scope)（S1:128），scope 在 phase 2–3 是 `resident_mirror:<node>`（换节点即新 scope）、phase ≥ 4 是 `pool_enforced`（全池一次）；depth2/depth3 写组合执行键，含 attempt（1 或 2，S1:129）。`delegated_scan`、`github_f_pr` 不写任何执行键。`attempt` 是入队字段、参与作业键（S1:653、S1:669），不能原地改。

规则：

1. 租约 10 分钟，节点每 ≤ 3 分钟续租（带进度计数，G10）；清扫每分钟。
2. **过期且未 `started`：**回 `queued`（同一作业，`origin=restored`），没有键被消耗，可在任何节点重领。清扫走与 `ci_job_release_v1` 相同的释放核心、`count_release=false`（过期不算一次主动释放）；再次租出时 `head_release` 额度检查照现有逻辑进行（S1:694）。这是改派的主路径，也是验收“断网自动改派”的测试对象。
3. **已 `started` 的作业丢失：**原作业记 `failed`（原因 `lease_lost_after_start`），按 `kind` 与 `combination_mode`：
   - `delegated_scan`、`github_f_pr`：没有执行键，清扫自动入队新作业（attempt=2、`origin=backoff-retry`、记父作业、`excluded_node_ids` 含原节点）；attempt=2 再丢失则停止并告警。扫描子作业的父作业元组不变，结果仍能交回。若排除原节点后没有任何合格节点（例如阶段 2 只有 DESK 是硬化档），挑选时忽略排除、仍派给原节点的新 E1。
   - `combination_execution` + depth2/depth3：同上，新作业 attempt=2 写新的组合执行键。
   - `combination_execution` + depth1：phase 2–3 可在别的节点再执行一次（新作业、`excluded_node_ids` 含原节点，scope 不同不冲突）；phase ≥ 4 该 head 已在全池烧掉，与 v0.9“executed-heads 全池”和常驻现有烧头规则一致，须推新 head。是否为“已证明无副作用的丢失”开例外见 §9 Q5。
4. **发布类作业不改派。**发布键已 `reserved` 而未观察到结果的为 `unknown`；按阶段 1 已审核的规则，UNKNOWN 永久、不退款、不能转成“已证明不存在”（S1 README；S1:991-993、S1:1088-1098）。当班读回 GitHub：已发布的照常结算；读不到的，这个 head 的这项检查不能再发布，须推新 head。本文不改这条规则；它的代价（预留后发布者掉线会烧掉一个 head）写进阶段 4 的告警与看板。
5. JIT 作业：GitHub 侧注册结果不明时用读回恢复，不盲目再建身份（`stage2-readiness.md` JIT challenge 行）。

### 6.5 阶段 4：N 主

**目标：**任何持钥且硬化的节点都能发布；列车维护由列车租约决定；额度、执行记录全池统一；托管免费分钟作溢出。

**内容（按顺序）：**4E 先行——常驻执行器暗装：发布段按 phase 选路（phase ≥ 4 走服务端预留、`external_id` 用 `clued-ci:<keyid>`，§5.3），角色探测与“非当班一律 DEFERRED”（S2）改读 `ci_duty_holder_v1` 的结果；4A phase 3→4 切换（§5.1 第 3 步）；4B executed-heads 与每日上限改全池（`pool_enforced`）；4C 第 8 段重试与 depth2/depth3 组合（S1 要求 phase ≥ 4）；4D 托管 Windows 溢出（`04463fcd`）与 Linux 托管中转共用免费分钟，Actions 预算 $0 硬上限不变；4F 两节点假设残留清零（对照 `9cac75be` B 部分）。

**进入条件：**阶段 3 退出验收通过；4E 已在所有常驻节点上线；[机器] 对账零差异天数达标（Q2）且期间至少一次交接；切换时无开着的绿；Owner 确认 v0.9 的 N 主进入条件（原文待核，U1）。

**退出验收：**两个以上发布者在同一天各自发布过不同 PR 的必需检查，服务端绿账显示任何时刻一个仓库最多一个开着的绿；人为让列车租约持有者离线，≤ 15 分钟（10 分钟租约 + 5 分钟静默）另一节点接手列车维护且先完成清扫，无重复发布；免费分钟溢出受预算上限约束的实测记录。

### 6.6 阶段 5：任意新机器一键加入、收尾旧路径

**目标：**以后新增的机器走一遍标准流程（除一次 UAC 外无人工）就成为节点；看板直接读服务端；旧的单活代码路径与兼容角色收掉；受信档按 3E 设计实施（若 Owner 批准）。

**内容：**5A 一键接入（`5500739b` 内容 3）：节点准备（`25ac6c5f` 的 prepare-node 脚本）+ 节点代理安装 + `init-keys` + 登记导出 + 自动出现在 `/ci-nodes` 待批准 → Owner 两步批准 → 所有发布者的钉住清单更新（经常驻升级通道下发，`018da927`）；5B 节点档案（电源、睡眠、自启、断网恢复、可用时段）入仓库；5C 看板（`679a0c2b`）改读 `ci_nodes_v1`/`ci_node_liveness_v1`/`ci_jobs_v1`，补利用率、队列等待、改派次数、烧头次数；5D 收掉 ci-admission 兼容角色（此前 G9 已使准入不依赖它）和常驻执行器里阶段 4 已不走的单活分支。前提：静态检查确认迁移里除 `ci_duty_holder_v1` 外已无任何 `'ci-admission'` 判定；`binding_role_admits_v1` 先改为“无行即拒”；角色行只撤销、不删除（保留历史）。顺序反了会让尚未迁移的调用者对任何连接放行（§5.1 己类）；5E 受信档实施（另行授权）；5F 资源维护（`0c51fb42`）：磁盘、镜像缓存预热、E1 镜像轮换。

**进入条件：**阶段 4 退出验收通过。

**退出验收：**一台新机器或重置过的机器走标准流程接入并领到作业（`5500739b` 验收 4）；`4972f2fa` 验收 1–6 全部满足。

## 7. 每台机器加入资源池需要什么

先说结论：**要接入的是两个节点（DESK、TURING），不是 7 个 runner。**槽位数是工程实测项（2C），表中是首装与预期上限。

| 宿主 / 现注册 | 现状 | 进池后的样子 | 需要做的（按阶段） | 卡点 / 未知 |
| --- | --- | --- | --- | --- |
| **DESK-W-591**（公司主节点，64 GB 级，WSL 28 GB/16 CPU，C: 约 65 GiB 空余） | 常驻执行器（发布者，持 App 5368905，连接 `44dc0846`），`CluedResident-Linux`；同时托管 5 个通用 runner；FINAL 包待在 DESK 上构建（今晚安装线） | 一个节点；首装 1 个 E1-Linux 槽，预期可到 4 个 Linux + 1 个 E4 Windows（与原 4+1 个 runner 相当）；发布者，阶段 2 起硬化档 | 阶段 2：完成今晚安装线并登记进 `ci_nodes_v1`（登记导出 + `/ci-nodes` 两步批准）；心跳令牌已有；`init-keys` TPM 路径首次实测；启用 Hyper-V（Windows 11 Pro 自带）；C1b 发布者边界隔离；节点代理；E1 镜像；E1/JIT 跑通后注销 5 个注册、退役 `CluedCI-Linux`；E4 实测 | 默认用户 root（预演要包装器）；公司网络 TLS 检查/代理未知；Hyper-V/TPM 状态未知；需要 Owner 在现场或 RDP 做 UAC |
| ├ company-linux-01..04 | `CluedCI-Linux` 里 4 个 runner，同用户同 Docker；03、04 不在心跳矩阵里 | 不再存在；Linux Docker 作业由 DESK 的 E1 槽 + JIT runner 承接 | 2E 最后一步注销 | 注销前须有 E1 + JIT 替代容量，否则 Linux 通用作业容量中断 |
| ├ company-win-01 | Windows 服务，`.\clued-runner` | 不再存在；Windows 作业由 E4（或 Q3 的退路） | 2E；先换 PR880 资格工作流的承载者 | E4 能否以服务身份运行、映射输出未经实测 |
| └ company-win-02（控制机） | 常驻执行器的控制 runner | 保留（常驻组件，不是池成员） | 无 | — |
| **TURING**（家用，16 GB 级，WSL 6 GB/3 CPU，C: 约 50 GB 空余） | 常驻执行器（发布者），已登记 `b24be772`（pending、未核验、未批准），有心跳，持 CI 准入 | 一个节点；1 个 E1-Linux 槽（内存是硬约束）；发布者，阶段 3 起硬化档 | 阶段 2：Owner 两步批准 `b24be772`；2G 装节点代理执行部分 + C1b 隔离（改派实测的第二节点）；阶段 3：发布侧与硬化 | WSL 6 GB + 1 个 E1 + 宿主能否同时容纳须实测（U3）；已知 WSL 退化与内存碎片（`independent-ci.md:304`）；不能睡眠 |
| ├ home-win-01 | Windows 通用 runner | 若 E4 不行，阶段 2 作 Windows 加固常驻退路（1 槽、低优先级）；阶段 3 起迁走 | 视 Q3 | 宿主内存紧 |
| ├ home-win-02（控制机） | 常驻执行器控制 runner，平时停止 | 保留，不计入算力池（`183ee67c`） | 无（14 天离线会被 GitHub 自动注销，定期演练） | — |
| └ home-linux-01 | 已退役（`183ee67c`） | 不进池 | 无 | — |
| **以后的新机器** | — | 一个节点，槽位按容量 | 阶段 5 一键接入；默认不持钥（`b4cd00c5` 第 7 项），只做执行节点 | 每台须 Owner 两步批准并钉进所有发布者的清单 |

## 8. 任务拆分

### 8.1 新建的 KooYomi 子任务（挂在 `4972f2fa` 下）

| 代号 | 标题 | 依赖 | Owner 门 | 碰常驻代码？ |
| --- | --- | --- | --- | --- |
| T2A | 阶段 2A：服务端统一迁移（当班函数清单定稿与静态检查、当班判定函数与全部入口、水位、领下一个作业、租约清扫、phase 推进、第六项发布键、准入不随交接作废、可用时段） | 无（可立即开工） | 生产迁移授权 | 否 |
| T2B | 阶段 2B：签名网关、节点资格报告、作业状态机、绿账旁路镜像 | T2A | Worker 发布授权、迁移授权 | 否 |
| T2C | 阶段 2C：节点代理与 E1-Linux 一次性环境（含留痕负向测试、槽位实测） | T2A（接口）；可与 T2B 并行开发 | 机器安装授权 | 否（新目录） |
| T2D | 阶段 2D：JIT Worker 与每作业钩子 | T2B；Owner 开通账户（Q4） | 账户/App 开通、Worker 部署 | 否 |
| T2E | 阶段 2E：DESK 整机改造（盘点、发布者边界隔离、登记批准、E1/JIT 跑通后注销 5 个注册、退役 CluedCI-Linux、E4 实测） | T2B、T2C、T2D、今晚 DESK 安装线完成 | 机器安装、runner 注销、节点批准 | 否 |
| T2G | 阶段 2G：TURING 节点代理执行部分（1 个 E1 槽、发布者边界隔离） | T2B、T2C | 机器安装、节点批准 | 否 |
| T2F | 阶段 2F：扫描作为池作业（当班入队、硬化节点执行、投递箱交回） | T2B、T2C、T2E（DESK 硬化与扫描批准）、`018da927` 合入、`9cac75be` A 部分 | 常驻安装波 | **是** |
| T3 | 阶段 3：所有发布者硬化、备机兼中转、旁路镜像与对账、受信档细化设计 | 阶段 2 退出验收 | 安装、Source 改动、扫描签名批准 | 是 |
| T4 | 阶段 4：N 主切换（先暗装 4E 常驻按 phase 选路，再切 phase 4；全池额度、列车租约取代 2b、托管溢出） | 阶段 3 退出验收 + 对账达标；内部 4E → 4A | 迁移、安装、N 主进入条件 | 是 |
| T5 | 阶段 5：一键接入、看板读服务端、收尾旧路径、受信档实施 | 阶段 4 退出验收 | 安装、受信档 | 是 |

### 8.2 关键路径与并行

```text
现在 ─┬─ T2A ─┬─ T2B ─┬─ T2D (要 Q4 账户) ─┐
      │       │       ├───────────────────┼─ T2E (要 DESK 今晚安装线) ─┬─ T2F (要 018da927) ─┐
      │       └─ T2C ─┴─ T2G ─────────────┘                            │                     ├─ 阶段 2 验收
      ├─ Owner 开通 JIT 账户 (Q4)                                      └─────────────────────┘
      └─ 018da927 合入
阶段 2 验收 ─ T3 ─(对账达标)─ T4[4E 暗装 → 4A 切换 → 4B–4F] ─ T5
```

- 现在就能开工且不撞常驻代码的：T2A（服务端），T2C 的细化与镜像构建（新目录）。
- Owner 侧可立即并行的：JIT Worker 单独账户开通（Q4）、TURING 节点 `b24be772` 的两步批准。

### 8.3 与其他线的关系

| 任务 | 关系 |
| --- | --- |
| `018da927` 原地升级通道（并行会话） | 常驻侧改动（T2F 起）都排在它合入之后；阶段 5 的钉住清单更新经它下发。 |
| `9cac75be` 两节点假设 | A1–A5 是阶段 2 进入条件；A5（工作流用 TURING 的连接）在 T2A 之后可改为调用当班判定；B 部分措辞在 4F 对照收尾。 |
| `c59e697c` 并行扫描 | 前一半（当班节点内三扫描并行）照原计划随安装波发；后一半（任意多台分摊）即 T2F。 |
| `25ac6c5f` 节点准备工具 | 阶段 5 一键接入复用；T2E 用它核对 DESK 前置条件。 |
| `5500739b` 可用性与一键接入 | 可用时段字段在 T2A；节点档案、自恢复抽测、一键接入在 T5。 |
| `679a0c2b` 算力面板 | 阶段 2 显示 DESK 旧注册退役；阶段 3 对账作业；阶段 5 改读服务端。 |
| `0c51fb42` 资源维护 | 阶段 5 的 5F；E1 镜像与缓存的盘容量从 T2C 起就要算（U4）。 |
| 合并列车 2a/2b（已合入） | 车头身份以 2a 为准；2a 入口在 T2A 改走当班判定；2b 在阶段 4 退场。 |

## 9. 需要 Owner 拍板的事（每项一个弹窗问题，推荐项在前）

**Q1（确认）阶段 4 用列车租约取代“当班 + 心跳接班”，这个切换方式可以吗？**
- 可以，按本文：一个事务里关掉心跳接班、原当班直接成为第一任租约持有者、phase 升到 4，可一步回退（推荐）——N 主已由 `b4cd00c5` 第 4 项和 `871a2b0d` 定下，这里只确认切换做法：无空窗、无双当班。
- 先不定，阶段 3 结束时再按当时情况设计切换——不影响阶段 2–3，但 T2A 的当班判定函数仍会先做。

**Q2 绿账从本机权威切到服务端权威的条件？**
- 连续 7 天对账零差异且期间至少一次当班交接（推荐）——覆盖一周的真实批次和交接场景。
- 连续 3 天零差异——更快，但样本少，交接场景可能没覆盖到。
- 阶段 4 开工即切，不等对账——最快，风险是镜像有缺陷时切换后才暴露。

**Q3 DESK 改造后 Windows 作业放哪里？**
- 先测 Windows Sandbox（Windows 11 Pro 自带，零费用），不行再退到 TURING 上 home-win-01 作加固常驻 runner（推荐）——就是 v0.9 第 5 项的原方案。
- 在 Windows Sandbox 测通之前保留 company-win-01 常驻不注销——Windows 容量不中断，但 DESK 推迟成为硬化档，阶段 2 验收要等。
- 不做自建 Windows 一次性环境，Windows 作业只用托管免费分钟溢出——省事，但 10 月免费分钟 23 日前就用完了，容量不可靠。

**Q4 JIT Worker 的单独 Cloudflare 账户什么时候开？**
- 现在就开，与 T2A/T2B 并行（推荐）——这是阶段 2 关键路径上唯一只能由您做的事，早开不耽误后面。
- 等 T2B 签名网关合入后再开——晚一点，但到时会卡住 T2D/T2E 一段时间。

**Q5 阶段 4 起，节点在作业跑到一半时掉线，这个 head 怎么办？**
- 照现行规则烧掉，需推新 head 重跑（推荐）——与 v0.9“executed-heads 全池一次”和常驻现有烧头规则一致，不改已审核的阶段 1 键语义；看板统计烧头次数，频繁时再议。
- 加一条例外：E1 销毁有签名证明、且没有任何发布键被预留时，允许同一 head 在别的节点再跑一次——少烧 head，但要改阶段 1 的执行键语义并单独审核。

**Q6 怎么算“每台机器都经池领到作业”（`4972f2fa` 验收 2）？**
- 按物理宿主算：DESK、TURING 各领到真实作业，且原注册承担的每类作业（Linux Docker、Windows、扫描）各有一次实测（推荐）——company-* 和 home-win-01 本来就是这两台机器上的注册，改造后不再单独存在。
- 按原 runner 注册逐个算——改造后这些注册已注销，没法逐个实测，只能保留旧注册，与 v0.9 的“机器不专用、作业专用”相冲突。

## 10. 未决项与风险

| # | 项 | 处理 |
| --- | --- | --- |
| U1 | v0.9 原文未读到，阶段 5 的内容和“N 主进入条件”是按 Decision 与 `stage2-readiness.md` 归纳的 | 能读资料中心的会话对照 v0.9 §11.2、§13 第 4 项核对；有出入以 v0.9 为准并修本文 |
| U2 | DESK 的 Hyper-V/TPM/公司网络代理状况未知 | T2E 第一步只读盘点 |
| U3 | TURING 内存能否容纳 1 个 E1 槽；DESK 实际可开几个 | T2C 实测：E1 内存上限、并发时宿主可用内存 |
| U4 | E1 镜像和缓存占盘（DESK 约 65 GiB、TURING 约 50 GB 空余） | T2C 给出镜像大小与保留策略；纳入 `0c51fb42` |
| U5 | JIT Worker 免费额度是否够（v0.9 成本模型 `N×(86400/H+86400/P)+86400/L+J×R+U`） | T2D 开工前按实际节点数、作业数算一次，写进任务；超出免费额度即停，不自动付费 |
| U6 | 改造期间 Linux 通用作业容量 | T2E 顺序为“替代容量跑通 → 再注销旧注册” |
| U7 | 2b 自动接班尚未开（等影子审核） | 与本设计无冲突：阶段 2–3 正是靠它；阶段 4 它退场 |
| U8 | 发布预留后发布者掉线会烧掉该 head 的该项检查（§6.4 第 4 条） | 阶段 1 已审核的规则，本文不改；阶段 4 看板统计并告警 |

## 11. 审核记录

- r1：独立审核 FAIL（2 BLOCKER、7 MAJOR、5 MINOR、3 NIT）。要点：阶段 4 切换条件循环（列车租约要 phase ≥ 4 才能取得）；2a 入口仍认 ci-admission，阶段 4 会有两个当班来源；“绿账镜像”复用的写入路径本身是活闸门并建永久发布键；已开始作业改派与执行键冲突；UNKNOWN 发布键无结算路径；缺第六项检查的发布键；交接会作废全部在途作业；扫描硬化要求阶段 2 起已由代码强制；同宿主持钥与 E1 的隔离未处理。
- r2：逐条修正——§5.1 改为单一判定函数并列出全部入口、切换与回退各一个事务；§5.3 改用旁路镜像表，阶段 4 按阶段 1 的“先预留后发布”；§6.4 按键语义重写；新增 G8、G9、G10、C1b、T2G；补 T2E、T2F 依赖；Q1 改为确认、原 Q5（槽位）改为工程实测项、新增“掉线烧头”决定；“两台发布者”一律改为“所有发布者”。复审 FAIL（2 BLOCKER、4 MAJOR、4 MINOR）。
- r3：§5.1 改为五类 43 个函数的首轮清单（脚本取每个函数的最后定义）+ T2A 定稿与静态检查；切换事务同时建列车维护请求、按 acquire 封顶到期时间、要求无开着的绿与 4E 已上线；回退落到已死持有者时交给租约持有者；`sweep_required` 允许动作列明；账户到项目映射；G9 对所有作业类型统一并保留撤销检查，两个孪生函数同改；§6.4 按 `kind`/`combination_mode` 重写并新增 `excluded_node_ids`；清扫的释放计数写明；§6.5、§8 加 4E → 4A。复审 FAIL（3 个新 MAJOR、4 MINOR，r2 的两个 BLOCKER 已解决）。
- r4（本版）：phase ≥ 4 时服务端拒绝 2a 路径的 merge-slot 发布；专用长期列车维护认领，G1 不派维护作业；`binding_role_admits_v1` 移出甲类、另列“判定原语”，5D 加前提；“无开着的绿”依据写明（镜像 + GitHub 读回）；扫描重试无合格节点时回到原节点新 E1；多发布者签发准入去重；`clued_work_verify_v1` 的 `effective_at` 收紧列为预期变化。终审 PASS-WITH-FIXES（2 MINOR、1 NIT），三项已在本版直接修入（己类只限 ci-admission、维护认领的约束、无角色行账户的预期变化），审核者认为无需 r5。详见同目录 `REVIEW.md`。
