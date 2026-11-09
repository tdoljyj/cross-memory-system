# PR 与认领的最小源头绑定方案

已审 v0.2（df5bb575 自动发现修订）· Task 3432a00b · 实施基线 488b301a · 2026年11月9日

**一个 PR 只属于一个 Task，一个 Task 可以有多个 PR。Native 一张私有关系表存 `(user_id, repository, pr_number, task_id, 状态)`，在租户内以仓库与 PR 为唯一键；repository 复用现有规范仓库字符串，不新增数字仓库 ID 登记。准入按 PR 查 Task，再读该 Task 当前有效 claim/scope/fence/epoch；尾注仅供说明。v0.1 的多对多、拆合 lineage、准入向量全部取消。**

**绑定复用首次 head 授权。** 扩展现有持有人钥匙鉴权的 `authorize_head`，增加可选 `pr_number`；有编号时同一事务插入／校验 PR↔Task，再写原 head 授权。Task 从已鉴权 claim 派生，不能另报；已有绑定属于其他 Task 则明确拒绝。仓库身份沿用现有 repository／pr_ref 校验，不采用正文或 GitHub 作者作为凭据。不新增登记入口、分支意图表或控制器。

**消除首次准入死循环。** PR 编号尚未知时保留现有无 PR 的 head 授权。常驻现有 CI 身份发现 PR 后，Native 只依据精确 repository + head_sha + claim 的合法持有人钥匙授权，从唯一有效 Task 候选自动绑定；不新增创建 PR 后第二次 authorize_head 调用。不同 Task 的候选授权歧义明确冲突，不按作者、正文、时间最新猜测。编号已知时 authorize_head 的可选 pr_number 可直接原子绑定。poller 可发现无尾注 PR；未绑定时有界等待，不启动重套、不烧 head；guard 不要求开 PR 前已有 PR 绑定。

**身份不等于存活或执行许可。** 历史可信关联及 holder 首次关联先记 unknown；只有限定 CI 观察到实际 open PR，并通过当前 key/head/target/scope 检查后才能激活并发 Receipt。ordinary/read_only 查询不激活；unknown/closed 保留真实 Task/scope 供清理，返回无可执行 claim，不占合并队首。不自动重开已结束 Task。查询投影不计 head，完整准入、执行及发布仍通过原全部安全门。

| 变化 | 系统自动做什么 |
| --- | --- |
| 换认领、过期后重领 | 关系留在 Task；合法认领完成后读当前 claim，不搬旧 claim_id。过期且未成功重领时等待，不抢占其他持有人。 |
| 接管、私钥交接 | 原交接／排空／epoch 撤回机制不变；查询自动得到新当前认领，旧钥和旧授权继续失效。 |
| 普通续租 | 绑定不变；刷新有效期，不因 lease_version 变化重复扫描。 |
| 推新提交 | 同一 PR／Task；照旧逐 head 授权、差异与写集校验，不迁用旧 head 授权。 |
| PR 改 base／分支 | PR ID 未变则关系不变；重读实际 head/base、差异和写集，按原规则重新准入。 |
| 认领释放／Task 完成 | 当前投影立即不可执行，走原撤回；保留关系历史，不把释放当完成，也不自动重开 Task。 |
| 拆成两个 PR／合成新 PR | 都按新 PR 首次授权绑定单个 Task；不记录 lineage、不汇集 Task。该 Task 的认领必须覆盖新 PR 全部变更。 |

**只替换一个读取来源。** poller／companion 的发现与换认领重评、`full-admission` v1/v2、`clued-work-admission` 的准入／发布／adopt／清槽、train、merge-slot／merge-executor、guard／repush-preflight 全部改读同一 Native PR 查询结果，删掉各自正文／commit 回退和默认 global。已绑定无有效认领时明确等待；别人的绑定、写集不覆盖等真冲突明确报原因。权限撤销、未知状态及所有现行安全拒绝仍保留。

**必须改的契约与迁移。** 一张私有关系表及租户访问校验；扩展 `authorize_head` 输入／原子绑定语义，新增受现有 CI 身份保护的按 PR 读取能力。旧单值 `bound_pr` 的“同 claim 只能一个 PR”检查及清槽／撤回查询须一并改读关系表，不能留下第二份真相。历史仅凭唯一可信绑定回执自动迁入。保持现有单 claim 准入、sameClaimGeneration、逐 head 授权、队列及发布检查；保持安装 repository/config.scope，越界报 `scope_not_served`，不自动扩权。Source／Worker／契约须受审后继与闭包验收；无必须改冻结升级器的依据，不改账户、密钥存储或安装通道。

验收：无尾注首次准入、同 Task 多 PR、表内错误 Task 拒绝、全部上述变化、旧代际／越权／漏事件与乱序重查、全链路无尾注硬门；每提交每检查仍只执行一次。**DESK df5bb575 已审通过并要求以上自动发现修订；Owner 已授权审过直接实施。8ba 流程收拢另待审，不改变本项限定的实现授权。当前先实施不相交 Native 后端；整体尚未完成或部署。**

代码依据：`worker/work-claims.ts:141`；迁移 `20261011131755_work_claim_handover_execution_v1.sql:183,231,444,904`、`20261105120000_work_claim_ci_queue_assist_v1.sql:139`；`poller.mjs:149`、`full-admission-v2.mjs:187`、`train-maintenance.mjs:646`、`clued-merge-executor.mjs:184`、`clued_work_claim_guard.py:1177`、`resident-v2/entry-runtime.mjs:238`。
