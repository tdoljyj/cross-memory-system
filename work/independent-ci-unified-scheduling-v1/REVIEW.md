# 统一调度阶段 2–5 落地设计 · 独立审核记录

审核者：同会话派出的独立只读子代理（不带作者结论，只给文档与代码路径），对照仓库代码核查。

## r1 → FAIL

已核对无误：19 张 `ci_*` 表（阶段 1 的 12 张、2b 的 6 张、心跳范围 1 张）；G1（`ci_job_lease_v1` 要指定作业，S1:675）；G2（无租约清扫，只有 release 置 `expired`，S1:777）；`qualify` 恒拒（S1:429）；mode/phase 卡在 `prepared`/1（S1:266、S1:536）；列车租约 10 分钟（S1:1210）、5 分钟静默（S1:1188、S1:1245）、30 分钟防抖（S1:1192）；`attempt in (1,2)`（S1:74）；发布键唯一（S1:113）；绿账签名链列存在且无人写（S1:156）；2b 候选 20 分钟新鲜度（FO:957）；水位按连接 × 仓库（FO:185）。phase 数字 = 阶段号安全（只有 `<4`/`>=4` 比较，别处不读）。费用无违规。

| 级别 | 编号 | 发现 | r2 处理 |
| --- | --- | --- | --- |
| BLOCKER | B1 | §5.1 phase 3→4 前提循环：要先取得列车租约，但 `ci_train_acquire_v1`/`request_v1` 在 phase < 4 时拒绝（S1:1162、S1:1179） | §5.1 第 3 步：同一事务直接写入第一任租约，不经 acquire 的 phase 检查 |
| BLOCKER | B2 | 第二个当班来源没找全：2a 的 `merge_slot_admits_v1`（Q:485-493）、命令门角色闸（FO:661-681）、keepalive 都只认 ci-admission、不看 phase；阶段 4 会两个来源同时有效；新租约持有者写不了水位 | §5.1 列出全部入口，新增 `ci_duty_holder_v1` 并在 2A 全部改走它 |
| MAJOR | M1 | “镜像”复用的 `ci_publish_prepare_v1` 是活闸门：要求已开始租约（S1:1023）、建永久发布键（S1:287-291、S1:992）、`CI_OTHER_GREEN_EXISTS`（S1:1036-1040）；`external_id` 对不上；阶段 4 写序与阶段 1 相反 | §5.3 改用只追加的旁路镜像表；阶段 4 按“先预留后发布” |
| MAJOR | M2 | 已开始作业 attempt+1 回队与头执行键（S1:128、S1:751-753）冲突；attempt 是入队字段 | §6.4 按键语义重写；新增 Q5 |
| MAJOR | M3 | UNKNOWN 发布键永久，无结算路径（S1:991-993、S1:1088-1098） | §6.4 第 4 条写明须推新 head；U8 |
| MAJOR | M4 | 发布键只允许 5 项检查（S1:107、S1:978），缺 `kooyumi-work-admission` | G8，进 T2A |
| MAJOR | M5 | `ci_claim_current_v1` 要求准入连接此刻持有 ci-admission（S1:603-606），交接作废全部在途作业 | G9，进 T2A；阶段 2 验收第 4 条 |
| MAJOR | M6 | 扫描硬化要求所有阶段都由代码强制（S1:692、S1:1012）；T2F 缺 T2E 依赖；T2E 缺 T2D；TURING 执行部分无任务行 | C2 改写；§8.1 依赖补齐；新增 T2G |
| MAJOR | M7 | 冲突 B 未处理：`dd33353d` 后 App 私钥与跑 PR 代码的 E1 同宿主 | C1b，作为 T2E/T2G 进入条件 |
| MINOR | m1 | 2b 看门狗按账户，phase 按项目 | §5.1 第 5 步：账户级规则 |
| MINOR | m2 | 列车续租/释放/确认/推进不看 phase（S1:1215-1300），回退须原子清持有者 | §5.1 第 2、4 步 |
| MINOR | m3 | `ci_node_current_v1` 本来不看心跳，要求存活是新行为 | G5 改写 |
| MINOR | m4 | Q1 重开已定的 N 主；Q5 是工程实测项 | Q1 改为确认；槽位改由 2C 实测、告知 Owner |
| MINOR | m5 | 写死“两个发布者”“TURING” | 改为“所有发布者”“另一节点” |
| NIT | n1 | `executor.mjs:366` 已过时，现为 `:500` | 已改 |
| NIT | n2 | 续租要求进度摘要变化（S1:718） | G10 |
| NIT | n3 | `independent-ci.md:9` 也过时 | S10、C1 |

## r2 → FAIL

完全解决：M3、M4、M6、M7、m1、m3、m4、m5、n1–n3。部分解决或引入新问题：

| 级别 | 编号 | 发现 | r3 处理 |
| --- | --- | --- | --- |
| BLOCKER | B1 | §5.1 入口清单仍不全：命令门角色闸管住其后全部动作（发布四个、撤绿三个，FO:672-676、687-855）；`work_claim_independent_begin/abort/drain_command_v1`（`20261029050000`:104-106 等）；角色探测 `clued_work_merge_slot_holders_v1`（`20261010112852`:172）；`work_claim_execution_current_v1`（`20261012114500`:52） | 脚本取每个函数最后定义，列出 43 个、分五类；T2A 第一项交付定稿并加静态检查 |
| BLOCKER | B2 | 4A 到 4E 之间服务端绿账看不见常驻开的绿，两个绿可并存 | 4E 暗装、按 phase 选路，作为切换前提；切换时要求无开着的绿 |
| MAJOR | M1 | 直接写入的租约没有 `request_job_id`，10 分钟内续不上（S1:1218-1226、S1:1148-1154） | 切换事务同时建维护请求作业，按 acquire 封顶到期，要求节点 active 且资格有效 |
| MAJOR | M2 | G9 表述有歧义，且缺“签发者连接未撤销”检查 | G9 对所有作业类型统一：签发时当班（写列）+ 签发者连接仍有效 + 准入与认领有效；调用者权限另判；两个孪生函数同改 |
| MAJOR | M3 | §6.4 分类错：`combination_mode` 恒非空（默认 depth1，S1:73）；只有 `combination_execution` 写键；没有作业级排除节点字段 | 按 `kind`/`combination_mode` 重写；G1 新增 `excluded_node_ids` |
| MAJOR | M4 | 回退可能落到已死的 ci-admission 持有者，且 2b 已关 | 回退时持有者不存活则同一事务交给租约持有者 |
| MINOR | m1 | 只认 `resident-node` 比现状窄 | 用 FO 口径（resident-node、unspecified），更宽的入口保留原口径 |
| MINOR | m2 | `sweep_required` 期间撤绿与保活必须照跑 | 列明允许动作 |
| MINOR | m3 | 2a 入口不知道项目 | 账户到项目映射，多于一个则关闭失败 |
| MINOR | m4 | 清扫回队是否计释放 | 写明 `count_release=false`，再租出照现有额度检查 |

## r3 → 待复审

## r3 → FAIL（3 个新 MAJOR，修完预计 PASS-WITH-FIXES）

r2 的 B1、B2、M2、M3、M4、m1–m4 已解决；M1 部分解决。甲类抽查：除 `binding_role_admits_v1` 外都是真正的角色管理。

| 级别 | 编号 | 发现 | r4 处理 |
| --- | --- | --- | --- |
| MAJOR | N1 | phase ≥ 4 时 2a 发布路径仍开着，phase 3 开始的批次可经 2a 开出服务端看不见的绿 | 丙类：phase ≥ 4 服务端拒绝 2a merge-slot 发布（`phase_requires_reservation`），回退反之 |
| MAJOR | N2 | 维护请求作业借谁的认领（当班无认领、PR 合并即失效）；G1 会把它租出导致续租失败 | 专用长期维护 Task 与认领，随列车维护者续、交接时转手；G1 永不派 `maintenance` |
| MAJOR | N3 | `binding_role_admits_v1` 无行即放行（`20261023010000`:65-66），5D 删角色会让未迁移调用者全放开 | 移出甲类为“判定原语”，只许 `ci_duty_holder_v1` 调用；5D 前提：零直接调用、改为无行即拒、只撤不删 |
| MINOR | m1 | “无开着的绿”标 [机器]，但服务端唯一来源是被声明“无人读”的镜像 | 写明依据为镜像 + GitHub 读回，§5.3 措辞同改 |
| MINOR | m2 | 阶段 2 扫描重试排除 DESK 后无合格节点 | 无合格节点时忽略排除、派给原节点新 E1 |
| MINOR | m3 | phase ≥ 4 多发布者为同一 head 签发准入 | head 授权与准入门计量去重 |
| MINOR | m4 | `clued_work_verify_v1` 不看 `effective_at`（`20261011131755`:420、:450），“行为不变”不完全成立 | 列为有意收紧并进回归测试 |

## r4 → 待复审

## r4 → PASS-WITH-FIXES

r3 的 N1–N3、m1–m4 全部解决，修正未引入 MAJOR 及以上问题；3→4、4→3 事务、G9、§6.4、§8 顺序、费用、任意多节点均无新问题。剩余三项已在 r4 文本中直接修入（审核者认为无需 r5）：

| 级别 | 发现 | 处理 |
| --- | --- | --- |
| MINOR | 己类：`binding_role_admits_v1` 带角色参数，也守 release-door（`20261003200000`:391、`20261004200000`:391），调用限制与 5D 改动若不分角色会改变发布门行为 | 限制与 5D 只针对 `p_role='ci-admission'`，加发布门回归测试 |
| MINOR | 专用维护认领须满足 `ci_claim_current_v1`：合成 `pr_ref` 三处一致（S1:588、595-597、601-602）、计量行（S1:610-611）；认领交接后须新建请求作业 | 写入 §5.1 第 3 步，作为 T2A/T4 验收条件 |
| NIT | 无 ci-admission 行的账户：现状放行、当班判定拒绝 | 列为 phase 1 回归测试的预期变化 |
