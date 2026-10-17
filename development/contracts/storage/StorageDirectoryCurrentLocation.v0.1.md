# 目录当前位置的独立自动登记 v0.1

本文约束原 Task e91a8ebc-3b2a-4e9e-bc6c-efbbbc60efcd 的有限后继实现。源码审核、本地测试、CI、迁移、部署和生产验收分别证明；本文不是发布许可，也不宣告旧操作成功。

## 目标与边界

目录在 Google Drive 中被改名或移动后，程序以固定原对象 ID 读取其真实当前位置，重新核对当前权限并更新登记。常规核对、重试和登记由服务端自动进行，不要求用户点击采纳，不依赖 Agent 在场。

本版仅处理有真实 cloud job 的原 P5 delete/restore：原完整单对象 I9 已关闭为 conflict，原 journal/attempt/attempt Receipt 与原请求精确一致，终止窗口已过，且未保存仍可正常结算的 typed result。目标是原确切 Artifact ID、固定 Drive ID、ordinary 目录，原登记 active 或 trashed，当前实际 active；不支持当前 trashed 与位置改变同时发生的情况。

原位置与当前位置都必须是同一受授权根内的普通目录，不能为 root/track，也没有 active 或 trashed 的已登记后代。真实物理子项可以存在，它们不因此被读取正文、纳管、移动或获得写入权限。任意已登记子树的前缀迁移不在本有限出口内。

只发送 Drive GET，不发送 move、rename、trash、untrash、replace 或 create。旧请求、旧 snapshot（包括 NULL）、provider attempt、原 Receipt 和未确认结果保留；原 mutation 仍为 conflict。当前登记使用新的独立 Receipt 与版本，不复活旧 writer 或撤销的授权。

## 认证与三阶段协议

每个 RPC 通过现有 public issuer-proof resolver。本次真实 issuer/generation、app、原 client lineage/job/root、当前同 Owner/subject/OAuth client 的 reader、真实 sealed full scope、modify、runtime qualification、Decision、master 与 lifecycle 都重新核对。调用者提供的 ID、GUC、布尔值或上一次响应不是认证依据。private helper/table 对 anon、authenticated、service_role 与 worker gateway 均不开放。

1. `registration_location_load` 返回固定原 Artifact 的 seed。旧 parent 只用于原身份与旧名称槽证据，无须使它重新 active。
2. Worker 只 GET seed 中的固定 Drive ID，得到 name/parent/version 提示。`registration_location_plan` 在服务端把实际 parent 解析成当前 Canonical 注册链，并从该链与一个安全名称推导新路径。提示不是许可；调用者不能提交任意完整路径获得权限。
3. Worker 按完整计划做两轮元数据观察，再调用 `registration_location_commit`。服务端重建完整计划并精确比较 authority、base version、旧关闭 Receipt、目标、原路径和新父链。

实际父链必须连续、active、Decision 当前并处于 runtime 允许的 track。两轮 GET 验证同一原目标、类型、严格布尔 trash 字段、My Drive ownership、唯一当前名称槽和完整 owner-private ACL。已有明确 access/sharing 摘要必须精确相符；缺失摘要只能按这次独立当前资格建立。完整 ACL 验证复用 V3 的严格内部观察 schema，不把 V4 计划送入旧完整提交函数。

观察从第一轮读取之前开始计时，至提交不得超过 30 秒。目标版本及语义事实两轮相同；祖先 incidental version 可前进，身份、路径、权限及登记 CAS 不变。锁后以及 Receipt-head 等待后重新检查真实 wall clock 和当前 authority。

## 并发与隔离

private 入口使用真正函数级 `SET lock_timeout='50ms'`、NOWAIT 与物理 `storage-object:` try-lock。该预算从 private 函数入口开始，不宣称约束外层 issuer resolver 的延迟。竞争、序列化冲突和死锁使整个资格子事务回滚；不产生终态失败或执行许可。严格绑定原 reference 的 private busy 响应映射成现有 pending/原任务退避，未知网络结果不能当作可信回滚或重派旧效果的理由。

锁集合包含根、root parent、原 parent、实际父链和目标 ID。Profile INSERT/UPDATE/DELETE 的 guard 使用 OLD+NEW root/root-parent 的同一物理域，生命周期恢复也参与，防止 target 被并发登记成另一个 profile 的根或根父级。取得锁后重查所有 live Artifact alias、profile root/root-parent alias、名称碰撞与后代。

检查已派发操作的完整旧、新几何，不能仅检查本次需要更新元数据的行。正在改变实际父目录/祖先的目录效果、目标依赖、物理 `(parent ID,name)` 槽、旧新路径与子树交集、仍可结算的 verified conflict 和未知范围均受保护。跨 profile/Owner 的物理 ID 依赖不能因本地路径或 root 不同而漏掉。无关兄弟只共享普通祖先时，不能因此扩大为全根禁止。

其他 active 隔离的候选集包含完整物理父链，而不是只包含目标 ID。只有本原 intent 的真实事务级 I11 出口可排除自己的 q；不得清除别人的 q、猜测 unknown scope 或把 root quiet 当作并发模型。

## 原子提交与重放

通过所有核对后，在一个事务中：

1. 创建精确请求哈希的 pending 独立 Receipt，关联原 intent/job/attempt/关闭 Receipt、完整 authority/plan/双观察与 before rows。
2. 安装仅本 intent 的 I11 出口，以及绑定 transaction、Artifact、Owner/profile、Receipt 和完整 before/after hash 的 target-only location permit。
3. 目标 CAS 更新到服务端推导的新路径、active 与本次合格元数据，版本恰加一。身份、provider ID、kind、governance、delete authority、source Decision 等其他字段不变。父链仍只用旧 metadata-only permit，旧 state/metadata permit 不获得改路径能力。
4. 仅原 q 变 resolved；原 mutation 保持 conflict 并版本加一、附独立结果标记。保存每个 changed Artifact 的真实版本/ref，Event、Receipt 与精确结果同事务完成。

任一步失败，包括最终 Event/Receipt 失败，须回滚所有行、q、journal、permit 和结果。成功重放先核对已保存结果，再检查尚未解决时的 seed；否则成功后的 q resolved/新路径会错误地拒绝丢响应后的查询。重复 commit 要求同原定位、版本、authority、plan 与双观察；load 可读回同一已提交结果，不发第二次 effect 或 Receipt。

结果为 `automatically_registered_current_state`、`current_artifact_state=active`、新旧不同的 Receipt、原 reference/base version、`current_path`、`execution_permitted=false`。`current_path` 是独立核验时的登记结果，不承诺此后外部不会再次改名；后续正常使用仍以当前 Canonical 与 provider 核对为准。

现有后台与 Owner Native 共用恢复组合：原 typed settlement 优先，同位置 V3 恢复仍保留，只有原目录位置路径不能完成时再独立尝试 V4。Owner 的 inspect/list/resolution sanitizer 及页面都验证并传递当前位置；普通 Agent projection 不因此增加完整路径。页面将其作为文本显示，不要求正常恢复确认。

## 验收要求

真实 PostgreSQL 测试覆盖 active/trashed 原登记 × 当前改名/移动、旧 parent inactive、错误 authority/CAS/观察/ACL、其他物理槽与子树隔离、已 started 的父目录效果、跨 profile 槽及异根物理父隔离、双连接竞争/反序、profile 插入与生命周期 phantom、一次提交/精确重放、最终 Receipt 失败全回滚和 private ACL。历史 alias/scope 的人工种子须明确是 disposable adversarial fixture，不能称为生产真实样本。

Worker 与实际 Native sanitizer→页面解析测试覆盖 sealed scope/AAD、GET-only、超时/晚到响应、严格 busy 映射、错误或丢失 Receipt、不重复效果与当前位置透传。保留所有失败与修正；重叠测试不能累加成独立覆盖。

最终精确源码须独立审核、通过适用 CI、正常 PR 合并、依真实迁移账本同 cohort 部署，再按生产数据库先于页面验收并持久归档。原 160500/173000 发布顺序和已应用迁移不能凭本文跳过。非 job I12、原旧操作实际效果、普通用户接入以及暂停域名事项不因本出口宣告完成。
