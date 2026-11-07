# 合并执行器的认领与 CI 恢复

关联合同：MergeAdmission §7、Clued Agent Contract §1.7；实施 Task `58c083f5`。

非受保护 PR 可以在认领续期时用完整的当前 head SHA 作为 `progress_ref`，确认这个 head 的合并。受保护 PR 保留 `Clued-Auto-Merge: <完整 head SHA>` 与精确 head 的 Owner 门口。

代码准备好后按合同加入默认分支的合并队列。认领保持有效到实际合入；等待期间不为合并重复刷新分支。轮到队首时若默认分支已前进，先正常对齐并推送。

准入前只跑了 `admission-gate`、其它 job 全跳过的成功工作流，在准入后由执行器自动全量重跑一次。它遵守准入标题的重跑上限；工作流仍需真正跑过正式 job 并通过，才能用于合并。已经重跑、缺 attempt、超过额度或运行已变化时，查看执行器摘要中的原因。

必需 CI 检查失败导致合并位退回时，认领会话会在 KooYomi 收件箱看到提交、失败原因和下一步。续期或 resume 后读取消息，核对提交；修复、推送新 head，再续期认领并重新入队。同一认领和 head 的通知幂等。

通知覆盖实际退回的合并位。超时、非队首失败、冲突及评审通知保持实施决定 `6678e107`、`5d7d3913` 的边界。

合入、迁移、发布及验收结果由持有会话当场记录到 KooYomi；CI 绿色、队首或本地测试本身不能代替实际合入和生产发布的证据。
# 完成事件丢失的持久恢复候选（Task `3a0e4219`）

先交SourceA精确登记前置（本地提交`b16643d8`），其中没有实际工作流或运行lane。
A真实合入且可信evaluator/Source按正常资格刷新后，才提交后继B工作流与运行代码。
自有完整性清单不能代替可信准入登记；本地测试中的`gate=[]`也不是线上资格（Task `3a0e4219`）。

`companion.mergeReconcile` 与源码 activation 均缺省关闭。本候选以独立伴随 lane 每5分钟唤醒固定
`clued-merge-reconcile.yml`，不依赖 completion、后续 push 或 GitHub cron。
唤醒消息只含 UUID，不含 PR/head 或授权；每次仍由原 slot reporter 和 executor
实时重读 Native、FIFO、Owner、规则、检查及 Source，按原预期 head 执行。
merge/update/rerun 的发送意图在出站前同步落盘；结果不明时不重复发送。
activation开启后，所有旧自动executor入口在任何读取或副作用之前只返回DELEGATED，
唯一自动执行者是带持久包装的新入口；关闭时原自动行为保留。
明确Owner手工操作是单独显式意图，保留原实时门禁，不冒充自动恢复或复用许可。
未知发送需要 Native 正证据收敛；缺正证据保持 UNKNOWN，不承诺无条件恢复上界。

工作流只指向专用自托管 Windows 控制器，沿用 `clued-admission` environment、
原 App 与原生工作流 token，和原执行器共用串行组。新增完整 Source/Role 清单
`scripts/ci/clued-merge-reconcile-source.json` 只证明受审字节完整性，不授执行、
调度或 Host 权限。不得从普通池标签、匹配 SHA 或测试通过推断主机已合格。
实际启用先完成原控制器迁移/隔离资格、准确 Source 接受及正常包升级门禁，
先排空所有旧执行任务并对账手工/自动未知操作，确认入口guard已接受后再激活（Task `3a0e4219`）；
本地候选不安装、不改线上配置，不借独立 CI App 的身份执行原合并控制。

执行端固定已实读TURING机器身份摘要及公开journal epoch，不能用同标签的另一台机器新建空账本。
资格安装须预建受保护 `C:\ProgramData\CluedControl\merge-reconcile` 及同epoch预算账本，并接入已有
保留/收集政策。观察原包原样写此自有 spool，不新增官方 Artifact/缓存/付费后备。
上限2000个 spool 项、2000个操作意图，达到上限明确停止，不能静默删未解决意图。
未知操作的解除必须依据原 Native 结果与精确主体，不能靠删 budget 文件重跑。
生产入口拒绝缺失/错epoch账本；换Host或epoch必须受审恢复原意图，不能静默初始化。

每小时最多12次 dispatch、60次 companion 读取；执行端持久上限1500次 API/小时、
250次/周期，GitHub剩余额度低于750时保留额度。429/限流遵守 Retry-After，
时钟回退、状态损坏或写盘失败停止出站，重启不清账本。不执行扫描角色。
在当班、主机资格/权限/Source均有效、无不明在途动作、API及队列可用且预算足够时，
再次观察界为5分钟加调度排队和原执行预算；断网、额度拒绝或未知在途不保证成功时限。
PR变化、主线前进、队首失败/已合并均由原执行器的现场守卫处理，旧事件不赋权。
