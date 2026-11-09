# PR–Task 后继：自动收尾与系统派生写集

Task 3432a00b · 2026-11-09 · 方向审核 a1cf2c6f；精确边界审核 72044ae2（北京时间 03:33）

方向与下述精确边界已审：沿用一入口、一批次记录，不加新票或控制器；实现优先复用原终结/adopt/release，不新增状态或表。按既定顺序直接测试先行实施。原 v0.2 绑定修复及合同后继是已审独立输入，旧通过数不能代替本稿新增行为的验收。执行顺序保持 342c → 3432（含 a/b）→ 8ba 原表 3/4/5/6，其余按数据；dcc 扫描许可迁移继续暂停。核心包 after342c 版 96d61e52 先在 342c 合入后由 DESK 整合；a/b 单独作为后继补丁跟进，核心包与后继代码均须按各自精确版本验收。

## a：可信 PR 终结驱动收尾

复用既有 CI 关闭/合并入口、Native PR 关系、adopt/release、撤销 outbox 和确认流程。CI 先读新鲜 GitHub 事实；Native 在原 user/Task 锁内幂等登记终结，不能用正文或持有人名字决定身份。

- 判断“最后一个”覆盖 Task 的所有 repository。另一 PR 仍 open、unknown、尚未可靠发现或有编辑占用时保留认领。只还某仓库的合并槽不能当作释放整个 claim 的依据。
- 终结动作携该 PR 最后真实准入记录的 claim/fence/epoch 与 CAS，比对当前代；仅有授权、尚未准入不能据此释放。旧 PR 或迟到事件不能因关系跟随 Task 新认领而释放 reclaim/handover 后的新持有人。
- 当前期执行、publication、未结 dispatch、交接或结果未知均不直接 RELEASED。有已派发工作按原 DRAINING、撤销与确认流程完成。`handover_drained_v1` 不是当前期全部空闲的证明。
- 同 Task 普通多 PR 不互相结束；竞速仍先走原 winner/adopt，不能复活 loser 或释放别的副本。只回收对应认领，不自动关闭业务 Task。
- 生命周期写入仅在原受鉴权终结入口，普通读令牌不获得通用 release 权限。重开、重复和乱序事件不得重复写入或复活终态。

已核定的边界：所有已知 PR 结束，但仍有 pre-PR 编辑占用或无法映射的宽泛 write_set 时，保持占用并报告待收尾，不能推断整个 claim 已无工作。若不能证明空闲则保守等待，在状态中写明未释放原因，不单独新增“最后 PR”豁免。

## b：系统派生，持有人登记，CI 完整核验

编辑前从 patch、文件操作目标与明确计划自动汇集资源，先执行原 claim；新增路径由当前 holder 通过原私钥/CAS/progress/conflict 更新后再写。无法可靠识别目标的脚本写入拒绝并定位，不猜全仓宽泛范围。认领前还不存在 PR 的路径不能假称来自 PR。

PR 已存在后，系统读取实际 repo/base/head 与完整差集，计数和前后快照一致，包含 rename 的新旧路径和删除路径。截断、移动或未知输入拒绝。CI 根据真实差集验证，不凭 PR 内容替 holder 扩权、覆盖他人的占用或获得私钥。

同 Task 多 PR 汇总所有尚存 PR、计划编辑和执行占用；不能用单个 PR 差集覆盖整个 write_set，不能自动收窄仍被使用的资源。保留原 renewal 预算/进展、CAS、冲突与逐 head 私钥授权。机械输出继续按 342c 限定资源策略和可信精确字节 proof；完整 packet 不删除这些文件，真实语义变化仍需完整写集覆盖。

## 新增 RED 清单

1. 最后 PR 终结释放；同仓/跨仓其他 open 或 unknown 不释放；保留编辑占用。
2. 旧事件、换代、重开、重复、winner/loser、交接及当前期执行不误释放；普通令牌无副作用。
3. 首次编辑前占用、rename/delete、完整性、移动 head/base、多 PR 联集正确。
4. 原冲突/CAS/错误 key/预算仍拒绝；CI 伪造扩权、机械内容冒充和跨 scope 拒绝。

先证明现版本真实失败，再以最小实现得到 GREEN；独立审核只审新增 diff 与冲突语义。补丁、精确 head、原始退出码与版本/Source 闭包按原 _transfer → DESK 开 PR 流程交付，安装/生产权限不由本稿授予。

## 审后原始实现定位（历史依据）

a 复用 `20261108161615_work_claim_pr_task_binding_v1.sql` 中既有 `clued_work_claim_adopt_v1`、`clued_work_merge_slot_return_v1`、`work_claim_pr_finish_v1` 的鉴权与用户锁；自动收尾必须另外核对真实准入代与当前 CAS。仓库队列返回不能代替 Task 跨仓空闲证明。`work_claim_handover_drained_v1` 只检查指定撤销 outbox 与旧 epoch 的 open publication，不能直接当作当前期空闲。Source 已落地主线的 adopt 信号也不必然表示 GitHub PR 已关闭，需独立读取终结事实。缺失可靠证据的分支保留 claim 并说明原因。

b 复用当前 holder 原会话的 claim/renew/verify，不给 guard、preflight 或 CI 新增私钥存储。编辑前适配层从结构化 patch/文件目标派生路径；缺覆盖时原 renew 成功后才写文件，集合未变不消耗续租。自动扩集合保守保留 `现有 write_set ∪ 新编辑目标 ∪ 已确认 PR 实际路径`，避免覆盖其他 PR、计划或执行占用；历史宽泛集合的收窄仍走现有鉴权流程。

现 `scripts/hooks/clued_work_claim_guard.py` 只判断任一 live claim 的提示逻辑不能充当路径覆盖硬门，也不自动 renew；需为 Codex patch 与结构化编辑目标接入执行前检查，未知 shell 写入须有可验证的目标清单。PR 后复用中央 admission 的 `changedPathsOfPullRequest` 与 Source `github.mjs` 的完整读取能力，并在调用侧保持计数、前后 repo/base/head 快照及 rename/delete 校验；单独路径提取函数不构成完整性证明。preflight 保持只读，CI 无权扩集合。

上述段落保留初始只读定位依据，不代表当前进度。核心 96d61e52 的旧测试不能记作 a/b 已通过。


## 当前实施记录（2026-11-09）

a/b 已形成实际代码和独立交叉审查结果：Native 在原授权入口记录显式收尾准备，在真正准入时保存不可变代际证据；原终结入口比较原证明、当前 CAS、写集覆盖、其他 PR 和执行占用。Source 沿用原批次记录保存准入证明，并通过有界公平游标重试终结。重复释放按原 Receipt 重放，不重复计入新动作，不自动关闭业务 Task。新增 SQL 由原 Supabase CLI 生成；未新增表、通用释放 RPC 或控制器。

b 的结构化编辑适配层从真实目标派生资源，持有人通过原鉴权、私钥、CAS 完成 verify_edit，必要时保留原集合扩展并重新核验后才调用实际编辑。Node 只读 preflight 从完整真实 PR 文件集给出写集并集计划，保留 rename 两端、删除和机械资源。普通公开 claim 读结果不是编辑授权。当前 Claude guard 的既有安装 matcher 不含 apply_patch；代码能解析 Host 传入的 patch，但不能声称现有安装已拦截所有工具或任意 shell 写入。

已完成针对新增行为的真实 RED→GREEN，现有原始证据包括 Native 16/16、原绑定 DB 12/12、Source 六文件 134/134、Node 三文件 60/60、编辑适配层 21/21、guard 72 通过加 3 个既有平台跳过、Worker 14/14，以及严格 v56→v57 反向合同证明。候选合同 v57 未部署，服务仍以实际读取版本为准。精确日志和文件摘要随最终交付包固定，不把不同提交的旧通过数合计成现场验收。

**现场边界仍在：**当前 GitHub App 的已核实权限未含完整 Actions 运行库存读取能力；Source 因而不提供已确认空闲证明，候选 Native 在该分支将保留占用并返回 runtime_inventory_unconfirmed，正式安装/迁移后仍需现场验收。非空外部执行也不能凭本地单元测试推断已停止。宽泛或多 PR 写集无法由最后一个准入文件包全部证明时保持待收尾。需要后续在既有正式部署和权限范围内取得真实完整库存及停止证据，才可宣称现场自动释放启用；本地代码通过不代替该验收。

DESK 在主线 245f88df 整合原核心包后另报告 24 个新增失败，现均已修复并通过独立审核：原 admission-self-tests 六文件 239/239，Source/resident 对应四文件 62/62，均无跳过。真实运行包依赖遗漏已补，旧 Native 绑定夹具与原因码分类随新接口迁移，保留正文不授权、只读不建关系、错 head/scope、真实冲突等拒绝边界。追加完整机械 DB 兼容验证正在核对旧夹具缺失的 CI 发现步骤。最终机械生成、完整套件、独立复核和可重放新包交付完成前，3432 仍为进行中。
