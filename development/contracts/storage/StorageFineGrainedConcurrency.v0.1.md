# Clued Storage 可判定结算（细粒度并发 A 部分）v0.1

## 0. 文档边界

- **类型**：与实现、迁移和验收直接绑定的工程合同草案。它不是实施授权，也不是上线证明。
- **后继提案**：§17 为 **r10.2 PROPOSED**。§1–§16 保留 r10.1 的完整接受文本与审核历史；§17 只提出本轮受支持的 cloud 单文件替换恢复修订，尚不代表该修订、候选代码或发布已获正式接受。
- **状态**：**APPROVED（r10.1）**——Owner Decision `94fc26b4` 批准。r1–r3 审核 HOLD_FAIL；Owner Decision `d6f985e6` 把方案拆为 A（本文件：在现有根目录写锁保护下让作业有界结清）与 B（对象级锁，Task `e58aca14`）。r4（只含 A）复审 HOLD_FAIL，r5 处理（§9）；r5 复审 HOLD_FAIL（1 BLOCKER、5 MAJOR），r6 处理（§11）；r6 复审 HOLD_FAIL（1 BLOCKER、1 MAJOR），r7 处理（§12）；r7 复审 HOLD_FAIL（1 MAJOR），r8 处理（§13）；r8 复审 HOLD_FAIL（2 MAJOR），r9 处理（§14）；r9 复审 HOLD_FAIL（1 MAJOR），r10 处理（§15）；r10 复审 **PASS**（1 MINOR、2 NIT），r10.1 一并处理，见 §16。
- **源码基线**：`a339f1d`（`main`，含第 1 步 PR #627）。SQL 函数以全部迁移（含锚点补丁）应用后的最终定义为准。
- **来源**：Owner Decision `2faa8148`；Task `10826ce2`。第 1 步：Decision `56d61a92`、Task `ce5c725e`。
- **起因**：BUG-20261008-001（Task `f7a4dd7d`）、BUG-20261008-002（Task `5c18ed64`）。
- **对既有合同的修订**（由 Owner Decision `94fc26b4` 批准）：
  - SFC `StorageFullCapability.v0.1.md:395、:429`：改名、移动、替换、回收站在结果不明时，可自动得出「未生效」或「冲突」，不再一律交 Owner 原生恢复（§4.3）。
  - SFC §6.1（`:383-385`）不修订：目标对象自身的 Drive 版本仍是准入与 Agent 前置条件（§4.2）。
  - 目录移动的恢复规则（SFC §6.2）不在 A 部分修订，归 Task `e58aca14`。

## 1. 现状

### 1.1 根目录级的锁与门

| 机制 | 位置 | 作用 |
| --- | --- | --- |
| 唯一索引 `resource_center_mutations_v1_single_writer` | `20260926160610_resource_center_mutation_journal_v1.sql:29-31` | 每个 profile 至多一个 prepared/started/uncertain 的 journal |
| journal `prepare` 的 `resource_center_provider_root_fenced` | 同文件 `:114-120` | 同一 `root_folder_id` 任一 profile 有未结 journal 就拒绝 |
| advisory lock `owner:root_folder_id` | journal、job begin/attempt/finalize、恢复、刷新、OAuth、级别切换、目录检查 | 短事务串行化 |
| `storage_root_quiet_v1` | cloud `load`（`20260928072813…:261`）；旧版 `clued_storage_cloud_worker_v1`（`20260927104436…:206`）；`clued_storage_refresh_worker_v1`（`20260927104436…:297`、`20260928051543…:339`）；`clued_storage_cloud_qualify_v1`（`20260927104436…:34`）；OAuth `complete` 与 `clued_private.storage_oauth_recovery_v1`（含 `20260930160000…:238`）；`clued_storage_write_access_v1`（最终定义 `20260930120000…:297` 起）；policy transition；目录检查（`20260929200000…:770`） | 根目录有未结 journal 时拒绝 |
| 触发器 `storage_refresh_mutation_fence_v1` | `20260927083521_resource_center_account_refresh_v1.sql:191-207` | 有刷新处于 `claimed` 时拒绝整个根目录上的 journal prepare/start |
| refresh `due` 跳过忙碌根目录 | `20261007200000…:146-152` 一带 | 根目录有未结 journal 时不刷新 |
| 续签登记与续签的内联 fence | `20260927053041_resource_center_renewal_v1.sql:103-106`；`clued_resource_center_renew_v1`（`:194-198`） | 同上 |
| `storage_root_stuck_v1`；queued sweep `root_busy` | `20261008000000` | 提交当场拒绝、排队不派发 |

A 部分保留根目录写锁（唯一索引、prepare fence、`load` 与提交处的门），只拿掉与写入无关的门：凭证刷新与 OAuth 重连（§4.6）、级别切换（§4.7）。

### 1.2 根目录锁之外、让作业「结不了账」或「误失败」的钉住

1. **凭证版本相等**：除 `load`、`report` 外的 cloud RPC（含执行器的 `begin`、`provider_attempt`、`finalize`）与 `verified_record` 要求 `credential_version` 等于 `load` 时的值（`20260928072813…:256-257`）。
2. **策略与授权代次相等**：五个加载点都要求快照策略即当前策略：`storage_cloud_job_current_v2`（`20260928072813…:7-30`，比较整个快照 JSON，含 `consent_receipt_id`、`actions`、`grant_receipt_id`/`policy_receipt_id`）、`clued_storage_scheduled_recovery_v2`、`clued_storage_native_recovery_load_v2:49-51`、`storage_verified_result_v2:216-218`、`storage_account_recovery_refresh_v1`（`20261007200000…:77-78`）。级别切换（最终 `clued_storage_write_access_v1`，每次只切换一个能力类）撤销旧策略、写入新策略（`consent_source='native_level_change'`、`scope_contract` /3）、递增 `auth_generation`、重发读取授权，并把排队作业按 `denied` 取消。接入时的策略为 `native_connection`、`scope_contract` /2（`20260930080000…:23`）。
3. **登记表祖先行逐字相等**：`verified_record` 保存目标父目录全部已登记祖先的完整行（`to_jsonb`），`settle_verified` 逐行比对（`20260929200000…:503-507、:628`）。
4. **Drive 祖先版本进入准入凭据与 authority**：
   - 客户端：identity 解析把链上每个节点的 Drive `version` 写入 `provider_version`，并给出 `root_folder_version`、`destination_parent_version`（`resource-center-google-drive-identity.mjs:70-83、:173-183`）；执行器把整个 identity 哈希进 `workspace_version`（`resource-center-cloud-executor.mjs:332`）；它进入准入绑定（`resource-center-mutation-host.mjs:286-290`）；每个效果在持久化 attempt 之后重新解析并逐字比较（`resource-center-google-drive-create-effect.mjs:140-142` 等）。
   - 服务端：`clued_resource_center_authority_v1` 要求 64 位十六进制的 `provider_version`，并经 `resource_center_directory_match_v1`（`20260929200000…:33-41`）对没有分享摘要的根目录、父目录与源父目录按 Drive 版本匹配。
   - Drive 在子项变化时递增文件夹版本（SFC `:406`），所以同一目录里任何别的变化都会让在途作业失败，且多在 attempt 已记录之后。
5. **新建核验钉住祖先 Drive 版本**（`resource-center-google-drive-postcondition.mjs:70-88`）。
6. **目录分享状态只靠版本兜底**：接入时登记根目录与分区（track）不写分享摘要（`20261001040000_storage_onboard_n0.sql:350-368`），摘要只由 P6.2 新建/移动目录与 P7 认领写入（`20261002130000` 文件头）。没有摘要的目录，分享被改动只能靠 Drive 版本变化发现。现有摘要 `googleDriveSharingDigest` 只含 `shared` 与权限 ID，不含角色；`googleDriveAccessDigest`（`resource-center-google-drive-sharing.mjs:31`）含类型、角色、域、可发现性与到期。

### 1.3 结果不明时能否自动结清

| 操作 | 自动结清 | 卡住的情况 |
| --- | --- | --- |
| 新建（文本、目录、二进制） | 不在：准入过期 10 分钟且 attempt 满 10 分钟后取消（`PROVIDER_EFFECT_ABSENT`）；在且可核验：登记 | 在但核验不过；连接被撤销、策略或代次变化后恢复加载被拒 |
| 改名、文件移动、替换、移入/移出回收站 | 只有「已生效且可核验」 | 改动没落地、被外部同时改动；同上的撤销与变化 |
| 目录移动 | 从不自动 | 只能 Owner 原生恢复（A 部分不改变） |
| storage job 中没记录 attempt 的操作；认领（有无 attempt 均可，认领从不写 Drive） | 准入过期 60 秒后由未尝试释放结清（`clued_storage_release_unattempted_v1`，最终定义为 `20261002170000…:28-50` 加 `20261002200000_storage_adopt_p7.sql:410-424` 的补丁） | 只覆盖 cloud 写入者的 storage job journal（`authority_snapshot_v2` 非空），由该 OAuth client 的 Worker 调用；连接断开后不覆盖 |
| 写入者绑定路径（`clued_resource_center_write_v1`：本地原生写入者、文件系统适配器；不经 storage job 的 legacy 写入也归此类） | 无 | attempt 只记在本地恢复存储（`resource-center-recovery-store.mjs:89-92`）或不记录；写入者可显式置 `uncertain`（`20260926160610…:202-207`）；数据库看不到是否已写 Drive |

**cloud storage job 路径**的写入效果在第一次 Drive 写入前把 provider attempt 持久化到数据库（`storage_job_provider_attempt_v*`，只有它们写这一列），执行器代码从不置 `uncertain`（cloud 写入者令牌仍可经写入者 API 置 `uncertain`，这类 journal 归 I9 (b)）；写入者绑定路径没有这个保证（上表）：`start` 之后它写 Drive 时不再查数据库、也不查准入是否过期（`resource-center-write-client.mjs:66-99`），文件系统适配器写本地盘，可能数小时后才经同步到达 Drive。今天对这类 journal 唯一的「无效果」释放 `fenced_no_effect`（`20260926160610…:180-200`）要求写入者绑定已撤销、Owner 证明执行器已终止、并证明终止后 Drive 上不存在。续传会话地址不保存。第 1 步已把恢复退避上限降到 10 分钟加抖动。

## 2. 成熟存储的做法（研究摘要）

| 做法 | 来源 | A 部分怎么用 |
| --- | --- | --- |
| 预生成 ID 后创建 | Drive `files.generateIds` | 已在用；任何非 2xx 按「未知→核验」 |
| 写入同时打标记，事后读回判定 | Drive `appProperties`（应用私有）；`headRevisionId`、`sha256Checksum` | 所有写入打 `clued_intent_id`；按语义字段判定（§4.3） |
| 以对象 ID 为稳定身份，版本只表示该对象自己的变化 | 各家通用 | 祖先按身份；目标对象仍按自身版本做前置条件（§4.2） |
| 续传会话只查询 | Drive / GCS 可恢复上传（约一周有效） | §4.5 |
| 指数退避加随机 | Drive 错误处理指南 | 第 1 步已做 |

条件写、对象级锁、多粒度锁、变更流、按账号限速等归 B 部分（Task `e58aca14`）。

## 3. 目标与不变量

**目标**

- GA1：新建、改名、文件移动、替换、回收站结果不明时，在有界时间内落到三种结论之一：已生效、未生效、冲突；结案后根目录写锁释放。认领由既有的未尝试释放结清；目录移动维持 Owner 原生恢复。
- GA2：资料中心里与作业目标无关的变化（祖先目录的子项变化）不再让在途作业失败；祖先目录的身份与分享状态变化仍会被发现。
- GA3：凭证刷新、同账号重连、级别上调不再等根目录空闲；级别下调有上限（在途目录移动除外，见 §4.7）、可撤回。

**规范性不变量**（每一步都必须满足；测试逐条覆盖）

- **I0 先记录后写**：provider attempt 在任何 Drive 写入前持久化。
- **I1 准入内发送**：cloud storage job 路径的任何 Drive 写入步骤只能在 `now < admission.expires_at` 时发出；执行器不自动重试写入。写入者绑定路径不满足 I1。
- **I2 判定时间门**（只适用于 cloud storage job 路径；写入者绑定路径的「未生效」只能按 I12 得出）：已记录 attempt 的作业，「未生效」结论只能在 `admission.expires_at + 该操作最长请求超时 + 10 分钟` 之后作出；最长请求超时：multipart 上传 60 秒、续传 `PUT` 120 秒、其余 Drive 请求 10 秒。「已生效」结论与未记录 attempt 的释放不受此限。
- **I3 标记归属**：标记缺失只在以写入时的同一 `oauth_client_id` 读取时才算证据。
- **I4 续传地址只查询**：保存的续传会话地址只用于状态查询，不续传、不删除会话。
- **I5 不放宽授权**：级别下调时排队作业与切换期间提交的作业按 `denied` 取消；结算只接受 §4.7 定义的后继策略。
- **I6 不碰外部改动**：冲突只记录、不自动修复。
- **I7**：（移入 B 部分，Task `e58aca14`。）
- **I8 每步至多一次**：每个效果步骤至多发送一次；每个结论都有 Receipt 与 Event。
- **I9 结案只依赖数据库**：一个定时任务（不经任何 OAuth client 的 Worker，不读 Drive）扫描所有 `auth_mode` 的 journal，无论连接、策略、授权纪元、凭证处于什么状态：
  - (a) **只对数据库强制先记 attempt 的 journal**——cloud 写入者的 storage job journal（沿用 `clued_storage_release_unattempted_v1` 的谓词：`authority_snapshot_v2` 非空、写入者为 cloud 写入者绑定；但**去掉** `c0.auth_mode='account_policy'` 与 `oauth_client_id` 两个条件（`20261002170000…:45`），以覆盖已撤销、已断开的连接。这样放宽是安全的，理由只依赖一点：记录 attempt 的两个函数（v2 `20260928072813…:123-125`；v1 最终定义 `20260928051543…:220-221`）都在 `for update` 锁住 journal 后要求 `state='started'`（相同 attempt 的重放只返回 `execution_permitted:false`，v1 `:235-238`、v2 `:139-141`），而释放在作业锁与根目录锁下复查 `provider_attempt is null`（`20261002170000…:61-63`）；所以 journal 一旦被释放就不可能再记 attempt、再写 Drive。第 4 步加回归测试，断言所有记录 attempt 的函数（含后续迁移打的补丁）都在 `for update` 下要求 `state='started'`，且重放从不允许执行）——没记录 attempt 的 started/uncertain 在 `expires_at + 60 秒` 之后释放，结论与该函数相同（Drive 从未被写）；认领沿用其补丁规则（有无 attempt 都按 `released_no_effect` / `ADOPT_NOT_SETTLED` 释放，因为认领从不写 Drive）。任何路径的 prepared（未 `start`）journal 在 `expires_at + 60 秒` 之后过期释放：两条路径都只在 `start` 成功后才写 Drive。
  - (b) **兜底**：(a) 未释放的其余全部 started/uncertain journal（**目录移动、认领除外**）——cloud 路径已记录 attempt 的、legacy 模式 cloud job（`authority_snapshot_v2` 为空，`20260928072813…:321`）中未记录 attempt 的、以及写入者绑定路径的全部——cloud 路径已记录 attempt 的在 `I2 时间门 + 2 小时` 之后，其余在 `expires_at + 10 分钟 + 2 小时` 之后；写入者绑定路径的 `expires_at` 为 prepare 后 30 秒（`20260926160610…:158`），这一时限只是策略上限，不是 fence（写入者不查准入是否过期；可以接受，因为结论是冲突而非未生效）。到时：若已有 `verified_result_v2`，先按 `settle_verified` 结清（失败则继续）；否则结案为 `conflict`（观察状态记为「未知」），并按 §4.4 写复核标记与隔离记录（写入者绑定路径按 journal 中的目标、源与名称写）。
  - 每个结论有 Receipt 与 Event。目录移动维持 Owner 原生恢复（SFC §6.2），不在 I9 范围内；它占用根目录写锁的时长不受本方案约束（§6、§7 照此限定）。
- **I10 空摘要不算匹配**：已登记目录的访问摘要为空时，永远不按「访问一致」处理。
- **路径划分**：本文的「cloud 路径」指 attempt 由数据库记录的 storage job（`storage_job_provider_attempt_v1` 或 v2，含 legacy 模式的 cloud job）；「写入者绑定路径」指经 `clued_resource_center_write_v1` 的本地原生写入者与文件系统适配器，其 attempt 不在数据库。I1、I2 只适用于 cloud 路径；I12 只适用于写入者绑定路径，不涉及共享的 cloud 写入者绑定。
- **I12 写入者绑定路径的终止门**（两层）：写入者绑定路径的 journal 结案为冲突后，
  - **任何**复核出口（含「已生效 / 登记观察到的文件」与「放弃登记」）都必须先具备：该写入者绑定已撤销；Owner 证明执行器已终止；Owner 证明本地效果已了结（证据 `local_effect_settled_after_termination`）：该操作涉及的**每个**本地路径（源与目标）都已回到写前状态，或同步客户端已停止且本地根目录已与 Drive 对齐；两种情况都还要求同步客户端在该根目录下**没有待同步的变更**（在线并显示已是最新，或已断开账号、丢弃本地状态后重新对齐），且 Drive 观察在此之后作出；「目标路径不存在」只对新建的目标算作回到写前状态。数据库不记录写入者绑定的种类（`resource_center_writer_bindings_v1`，`20260926160610…:268-276`），所以这项证据对写入者绑定路径的**所有**出口一律要求（不经文件系统同步的写入者，Owner 可直接证明「无本地效果」）；出口所依据的 Drive 观察在这些证据之后作出。
  - 得出「不存在 / 未生效」的出口**另需**：终止后 Drive 上不存在（或语义状态等于写前）的证明，即 `fenced_no_effect` 的 `provider_absence_verified_after_termination`。
  - 证据不全时隔离与复核标记保持（目标槽与所在子树的目录移动、回收站被占，但根目录已解锁）。得出「已生效」的出口按观察到的文件登记。
- **I11 复核标记只经出口清除**：复核标记与隔离记录只能由 §4.4 的三个复核出口清除，每次清除必须引用同一事务内创建的出口 Receipt；其他任何写入（含登记表更新、管理员写入、回退后的旧函数）都不能清除或覆盖它们。

## 4. 设计

### 4.1 目录访问摘要补齐（先于去掉版本）

- **摘要口径**：登记表新增 `provider_access_digest`，用 `googleDriveAccessDigest`（含角色）计算；既有 `provider_sharing_digest` 保留不变。
- **目录匹配顺序**（§4.2 与服务端同一规则）：有访问摘要按访问摘要；否则有分享摘要按分享摘要（即今天 `resource_center_directory_match_v1` 的行为，P6.2 新建/移动与 P7 认领的目录都在此列，它们登记的版本本来就会过时）；两者都没有才按 Drive 版本。
- **接入**：为根目录与每个分区写入访问摘要（与登记同一事务，来自接入时同一次 Drive 读取）。
- **新建目录、目录移动、认领结算**：总是同时记录访问摘要；读取失败时重试，仍失败则该目录标为「摘要缺失」。
- **现有目录回填**（不是 Owner 对当前分享状态的批准，只是确认「自登记以来没变」）：
  - 执行者：专用定时任务，调用只授予该任务的 RPC `clued_storage_access_digest_backfill_v1`，每次一个目录。
  - 读取凭证：该 profile 所属连接的当前有效凭证，要求同一 `owner_id`、连接登记的根目录等于该 profile 的 `root_folder_id`、该根目录没有被拒绝（`storage_client_denies_v2` 与根目录拒绝）、具备读取范围；每次 Drive 请求前检查凭证剩余有效期（≥ 60 秒）。
  - 对象：只回填**既没有访问摘要也没有分享摘要**的目录（实际上是接入时登记的根目录与分区，以及更早的登记）。已有分享摘要的目录不回填，继续按分享摘要匹配，从不降级为按版本；它们的访问摘要只经目录检查或下一次 P6.2 / P7 结算写入。
  - 两段式：先在事务外用**同一次** `files.get`（`fields=id,version,permissions(...)`）读取版本与权限，版本与权限出自同一个响应；再开提交事务，在 advisory lock `owner:root_folder_id` 下复查 `storage_root_quiet_v1`、登记行的行版本（CAS）与读取前记下的登记版本。
  - 条件：**只有该响应的 `version` 等于登记行的 `provider_file_version`** 时，才写入访问摘要；否则（版本已变、读取失败、复查失败）该目录标为「摘要缺失」。
  - 含义：版本相等只证明「自上一次写入登记版本以来没变」，不证明那次写入是 Owner 对分享状态的批准（例如目录移动的后代版本更新 `20261002090000…:173`）。本方案接受这一点：回填后的基线与今天按版本匹配所保护的基线相同，没有放宽。
  - Receipt 操作 `storage_access_digest_backfill`，记录目录、登记版本、读到的版本与摘要。
- **摘要缺失的目录**：补齐前继续按登记的 Drive 版本匹配。目录检查的观察合同（`20260929200000…:804-806`）在第 2 步扩展为同时接受 `provider_access_digest`。I10 保证空摘要不会被当作一致。
- **摘要缺失的自动恢复**（缺陷 `38bb5ddf`，Decision `24422a98`，迁移 `20261031050000_storage_access_digest_recovery_v1`）：原方案让页面提示 Owner 运行目录检查，已取消；摘要缺失由程序处理，不要求用户做技术检查。
  - 参照 Google Drive：文件夹权限沿父目录继承，文件夹版本号只要里面有变动就会变，不是共享信号。
  - 回填按顺序判定：
    - 版本等于登记版本 → `recorded`（原规则）。
    - 版本已变，但同时满足以下条件 → `recorded_inherited`（记录的基线不宽于父目录）：该目录的访问摘要等于其登记父目录的当前访问摘要；父目录按今天的匹配方式（有访问摘要用访问摘要，否则用分享摘要，同一次运行读取）仍等于登记值；父目录的登记行自 load 后未变。
    - 版本已变，但只有所有者本人能访问（Worker 报 `owner_only`）→ `recorded_private`。没有比这更窄的权限，所以不需要父目录；没有登记父目录的根目录也靠这条恢复。
    - 其余情况记为缺失，并写明原因：`not_found`（Drive 已找不到）、`unreadable`（没有可用的权限列表）、`version_changed`（暂无可比的父目录基线）、`access_differs`（比父目录多授予了权限，属于真实共享差异，继续拦截）。
  - 缺失目录永不放弃，按退避一直自动重试：30 分钟起翻倍，最长 16 小时一次。共享恢复一致或目录重新出现后，下一次重试就会恢复。
    - 尝试次数记在独立的 `storage_access_digest_recovery_v1` 表里，登记行结构不变；次数只用来决定何时请 Owner 关注。
    - 本修复之前留下的缺失标记会立即重试；一个目录重新变为缺失、或缺失原因改变时，次数从 1 重新计。
    - 瞬时失败不写入、不计次，只按退避推后。
  - 连接页不再出现“运行目录检查”。
    - 仍在自动核对的目录只显示一行状态；读到关注列表后，才加上“无需操作”。
    - 经单独的只读函数 `clued_storage_access_digest_attention_v1`，以业务语言列出需要 Owner 关注的目录（“为防止资料被意外共享，暂不向这些目录写入”）：真实共享差异立即列出；Drive 找不到、读不出、或没有可比基线（例如早于摘要登记、已分享给他人的资料根及其子树）的，同一原因连续 3 次后列出。
    - 程序无法判断时，由 Owner 在页面上一键“确认当前共享设置”（`clued_storage_access_digest_accept_v1`）：只接受最近一次核对（24 小时内）看到的那份共享状态，精确比对（CAS）后写入基线，单独记 Receipt `storage_access_digest_owner_accept`；不要求 Owner 做任何技术检查。
    - Owner 生命周期函数的源码有哈希钉住，所以关注列表另走只读函数，生命周期函数保持不变。
- **写入前边界扫描**（Decision `24422a98`，作业 `3f6c2a1e` 的 `DRIVE_BOUNDARY_DEPTH_LIMIT`）：扫描只看资料根以外（根本身不进入），参照 Drive“按对象和祖先链判断访问”的做法，无关内容不再让写入整体失败。
  - 逐层扫描，父级与同级命名空间总是最先扫完。
  - 超过深度上限或条目上限的文件夹，只按名字观察，不再展开；超过条目上限后，后续整层都不再列出。这些都计入不可枚举的 `partial`，目录检查的观察结果另带 `unscanned_branches` 计数。
  - 快捷方式当普通条目观察，不跟随。
  - 文件夹只比较身份（ID、名称、父级、类型、回收站状态），不比较 Drive 版本号。因此扫描期间在已列出的文件夹里新建的条目测不到；这本来就是时点检测，不是锁。
  - 孤岛规则不变：资料根以外、名字含 Clued、由 Clued 应用创建或打开的条目仍判违规。根被冒名、同名歧义仍失败。

### 4.2 祖先按身份，目标对象仍按版本

- identity 解析对**祖先**输出身份：Drive ID、名称、父 ID、`trashed`，以及按 §4.1 匹配顺序所需的访问摘要或分享摘要；按摘要匹配的祖先不再输出 Drive `version`，也不进入链哈希。两种摘要都没有的祖先保留版本。
- **目标对象**（替换目标、改名/移动/回收站的源、新建的目标父目录之外的同名检查）保留自身 Drive `version` 作为准入与 Agent 前置条件（`source_file_version` / `destination_file_version`，SFC §6.1 不变）。
- `workspace_version`、准入绑定、服务端 `clued_resource_center_authority_v1` 与 `resource_center_directory_match_v1` 同步改为按 §4.1 的匹配顺序（访问摘要 → 分享摘要 → 版本）；`provider_version` 改为只覆盖摘要缺失节点的版本（全部有摘要时为固定值 `sha256("clued.provider-version/empty")`，仍是 64 位十六进制，满足 authority 的格式检查）。
- `load` 返回的 descriptor 增加每个祖先的匹配方式（摘要或版本），执行器与服务端按同一份 descriptor 比较，避免两边口径不一。
- 效果在持久化 attempt 之后的复核按同一规则比较。
- **祖先链核对**（新建、改名/移动、替换、回收站的 postcondition）：按登记的 Drive ID 从根走到目标父目录，核对每个节点的 `id`、`name`、`parents[0]`、`trashed=false` 与登记身份一致，根目录的 `parents[0]` 等于登记的 `root_parent_id`；开始与结束各核对一次。目标名称的唯一性检查保留；祖先层的同名检查（`PARENT_AMBIGUOUS`）因按 ID 行走而不再需要。
- **认领与目录移动**在 A 部分保持现有的版本检查与摘要记录（`adopt-effect.mjs:41-44、:66-67`；`20261002130000` 的 `source_parent_version` / `destination_parent_version`）。

**版本消费者清单**（第 3 步逐一修改并测试）：`resource-center-google-drive-identity.mjs`；`resource-center-cloud-executor.mjs:296-310、:332`；`resource-center-authority-client.mjs:128-129`；`resource-center-mutation-host.mjs:286-290`；全部 `*-effect.mjs` 的 attempt 后复核；全部 postcondition；`clued_resource_center_authority_v1`；`resource_center_directory_match_v1`；`storage_verified_result_v2` 与 `settle_verified` 的祖先比对；认领与目录移动（保持不变，列入回归测试）。

### 4.3 三分法结算（新建、改名、文件移动、替换、回收站）

provider attempt 记录写前语义状态、期望写后谓词、写入所用 OAuth client；写请求同时设置 `appProperties.clued_intent_id`（新建已有；其余在同一个 `files.update` 里设置）。

- **语义字段**：`id`、`parents`、`name`、`trashed`、`explicitlyTrashed`、`mimeType`、`headRevisionId`（二进制）、`sha256Checksum`、标记。语义字段只用于结算判定，不进入准入（§4.2）。
- **期望写后谓词**（按操作）：新建——预生成 ID 存在、父目录与名称、类型、哈希相符、带标记；改名——名称为新名、带标记；移动——父目录为新父、带标记；替换——`sha256Checksum` 为新哈希、`headRevisionId` 不同于写前、带标记；回收站——`trashed` 为目标值、带标记。

| 实际状态 | 结论 |
| --- | --- |
| 满足期望写后谓词，且祖先链核对通过 | 已生效：`verified_record` / `settle_verified` |
| 等于写前语义状态、不带本作业标记，且 I2、I3 满足（新建：按 ID 404 且标记搜索为空） | 未生效：取消，`PROVIDER_EFFECT_ABSENT`；替换的写前 `keepForever` 固定按 `storage_revision_pins_v1` 记录或释放 |
| 其他 | 冲突（§4.4） |

I2 时间门之前只能得出第一行。I9 保证即使恢复加载被拒，作业也会结案。

- **上线前已开始的 attempt**（没有标记与写前状态）：沿用旧核验器判定「已生效」，从不判「未生效」，其余由 I9 结案。
- **残余风险**：Owner 在时间窗内永久删除刚新建的文件时，结果与「未生效」相同；Drive 变更流（Task `e58aca14`）上线后排除。

### 4.4 冲突结案与复核

- journal 新增终态 `conflict`；作业结案为 `attention_required`，原因 `PROVIDER_STATE_CONFLICT`，Receipt 操作 `storage_conflict_settle`，记录观察到的语义状态（I9 结案时为「未知」）。暂存件删除规则把 `conflict` 视同已结算。根目录写锁随之释放。
- **复核标记**：已登记对象的登记行标为「需复核」；新建写一条隔离记录（父 ID、名称、预生成 ID）；改名与移动另写一条目标槽隔离记录（目标父 ID、目标名称）。
- **强制点**：journal `prepare` 与 `clued_resource_center_authority_v1`。所有写入路径（storage job、legacy 的 `clued_resource_center_write_v1`、管理员 RPC、以后新增的路径）都经过这两处；没有经过这两处的写入路径在第 4 步一并改为经过，或停用。命中以下任一情况时拒绝（`storage_object_under_review`）：
  - 目标、源命中复核标记；
  - 新建、改名、移动的目标槽（目标父 ID + 名称）命中隔离记录；
  - 目录移动或移入回收站的源是一个子树，子树内有复核标记或隔离记录；
  - 任何操作（含认领）涉及的 Drive 文件 ID 命中隔离记录的预生成 ID 或复核标记；认领的目标槽命中隔离记录。
- submit 与 `load` 另行提前拒绝以便提示；在 `load` 被拒的排队作业以 `denied` 报告结案。
- **只经出口清除**（I11）：登记表上的触发器拒绝任何清除或改写复核标记、删除隔离记录的更新，除非该更新来自下面三个出口 RPC（判定依据是同一事务内由该出口创建的 Receipt，而不只是事务变量）。
- **复核出口**（Owner 原生页面，均有 Receipt）：「接受 Drive 当前状态」——按 Drive 当前语义状态更新登记行（新建：登记该文件或确认其不存在）；「放弃登记」——登记行置为已移除、隔离记录删除；「重新核对」——按 §4.3 / §4.5 再判一次。写入者绑定路径的冲突，所有出口都受 I12 约束（两层）；页面列出缺少的证据。注意：journal 结案为冲突后，迟到的写入者 `finalize` 会被拒绝（`20260926160610…:209` 要求 started/uncertain），已落地的写入只能经「已生效」出口登记。
- **只读核验的凭证**（重新核对与恢复中的只读核验）：接受满足以下全部条件的有效凭证：同一 `owner_id`、同一 `provider_subject`、同一 `oauth_client_id`；所属连接登记的根目录等于该作业的 `root_folder_id`；该根目录与该 client 没有被拒绝；具备读取范围；每次 Drive 请求前剩余有效期 ≥ 60 秒。记录所用凭证版本。连接被撤销后，复核在同一 Google 账号、同一根目录的新连接页面上可见。
- **谁来结案**：新建、改名、文件移动、替换、回收站：定时恢复能读 Drive 时按 §4.3；否则 I9。目录移动：Owner 原生恢复。

### 4.5 续传会话

- 会话 POST 之后、上传 PUT 之前，把会话地址加密写入 journal 的独立列 `provider_upload_session`（只写一次；不放进 `provider_attempt`，因为后者在多处按整体相等比较；专用 RPC，单独 Receipt `storage_upload_session_record`；与暂存件同一密钥体系，视为不记名凭证）；这次写入失败就不发 PUT，按 I2 等待后判定。
- 恢复只做状态查询（I4）：200/201 → 按已生效核验；404/410 → 与按 ID 404 同时成立且过了 I2 时间门才算未生效；308 → 冲突。
- 地址保留到会话过期（约 7 天）；「重新核对」在过期后查询为 404 且按 ID 404 时，可把冲突改判为未生效（有 Receipt），之后删除地址。
- 现有新建的不存在证明以「地址从不保存」为前提，本节上线时同步修订。

### 4.6 授权纪元、凭证与重连

- **授权纪元**：连接新增单调递增的 `authorization_epoch`，按 `storage_connections_v1` 列的以下迁移递增：`revoked_at` 由空变为非空；`provider_subject` 变化；`provider_scope_profile` 按 legacy < normal < full 变窄；`state` 变为 `reauthorization_required`。普通凭证刷新、同账号同 client 范围不变窄的重连、按 client 谱系的拒绝（`storage_client_denies_v2`）都**不**递增。作业快照记录它。
- **凭证接受**：执行器的 `begin`、`provider_attempt`、`finalize` 接受满足以下全部条件的凭证：版本 ≥ 快照版本；`provider_subject`、`oauth_client_id` 相同；范围不窄于准入时；`authorization_epoch` 与快照相等；每次 Drive 请求前剩余有效期 ≥ 60 秒。只读核验按 §4.4。provider attempt 与 verified Receipt 记录实际使用的版本。
- **要改的凭证钉住点**：服务端 cloud RPC 的版本相等检查（`20260928072813…:256-257`）；`verified_record` 的凭证相等；执行器 `credential()`（`resource-center-cloud-executor.mjs:224-229`，现要求 `credential_version` 严格相等，且只在取凭证时检查有效期）。
- **刷新与重连不再等空闲**：凭证刷新 claim/commit 去掉 `storage_root_quiet_v1`；触发器 `storage_refresh_mutation_fence_v1` 删除；refresh `due` 不再跳过忙碌根目录。OAuth `complete` 与 `storage_oauth_recovery_v1` 只对**不变窄**的重连去掉空闲门；变窄的重连在第 7 步之前保留空闲门（现状）。
- **变窄的重连**在第 7 步之后按级别下调处理（§4.7）：在途作业照 I9 结案，不会卡住根目录（在途目录移动除外，见 §4.7）。

### 4.7 级别切换

- **后继策略**：策略 P′ 是快照策略 P 的合格后继，当且仅当：连接、`provider_subject`、根目录、profile、`source_decision_id` / `decision_version`、`expires_at` 相同；`actions` 是 P 的超集；`scope_contract` 相同，或 P 为 /2、P′ 为 /3 且两者的摘要输入（tracks、`managed_root`、`root_parent`）相同；P 之后的每个策略都是 `native_level_change` 且链中没有收窄。五个加载点（§1.2 第 2 条）与 `verified_record` 统一改为：快照策略即当前策略，或当前策略是其合格后继。比较整个快照处，沿 `native_level_change` 后继链**只允许以下字段不同**：`policy_id`、`policy_generation`、`policy_receipt_id`（及旧名 `grant_receipt_id`）、`consent_receipt_id`、`scope_digest`、`actions`、`auth_generation`；其余字段必须逐字相等。
- **上调**（只增加能力）：切换前检查全部在途 intent 的快照，都满足后继规则时立即提交；任一不满足则按下调的挂起路径处理。
- **下调**（任何能力减少，含变窄的重连）：切换事务里取消排队作业（`denied`）；连接进入「切换中」，**该连接上所有新的 submit 与 `begin` 都拒绝**；只等待切换请求之前已 `begin` 的 intent，它们结算或按 I9 结案后，由定时任务提交新策略、递增 `auth_generation`、重发读取授权，并再次取消切换期间残留、属于被移除能力类的排队作业。上限：I9 的 2 小时加时间门；若在途的是目录移动（只能 Owner 原生恢复），页面提示「等待 Owner 处理目录移动」。挂起期间的上调排在下调之后一并生效。Owner 可随时撤回挂起的切换（恢复原策略，有 Receipt）；定时任务提交新策略失败时自动撤回并提示 Owner。读取授权在提交前保持原状。

## 5. 实施步骤

每步一个 PR，含迁移、Worker、测试与维护文档；生产迁移、发布与开关分别经 Owner 批准。各步 Task 已在 Owner Decision `94fc26b4` 批准后登记。全部步骤都在根目录写锁下运行，每步单独上线后系统保持一致。

1. 恢复与重派退避上限 10 分钟加抖动、恢复读取有界重试（已实施：Task `ce5c725e`，PR tdoljyj/cross-memory-system#627）。
2. Task `e2eb07d1`：目录访问摘要补齐：新增 `provider_access_digest`；接入写入根目录与分区摘要；两种摘要都没有的现有目录按「同一响应、版本未变才回填」的两段式定时任务回填；新建、目录移动与认领总是记录；目录检查的观察合同接受访问摘要；「摘要缺失」标记与提示（§4.1）。
3. Task `469700eb`：祖先按身份：§4.2 版本消费者清单逐一修改，含服务端 authority 与目录匹配、`settle_verified` 祖先按身份比对；目标对象保留自身版本；认领与目录移动保持不变并列入回归测试。验收含「同目录里出现别的文件，在途作业照常完成」与「分区被改为公开分享，写入被拒」。
4. Task `e91a8ebc`：三分法结算；I9 数据库结案（(a) 只释放数据库强制先记 attempt 的 storage job 与 prepared；(b) 其余含写入者绑定路径结案为冲突并写复核标记；认领按其补丁规则；排除目录移动）；冲突终态；复核标记、目标槽、子树与 Drive 文件 ID 检查（含认领）在 `prepare` 与 authority 强制，所有写入路径（含 legacy 与管理员）经过或停用；I11 触发器；复核出口与只读核验凭证规则（§4.3、§4.4）。
5. Task `2e439b59`：续传会话地址记录与只查询（§4.5）。
6. Task `300dcbd0`：授权纪元、凭证接受规则（含三处凭证钉住点）；刷新与不变窄的 OAuth 重连不再等空闲；删除刷新触发器与 refresh `due` 的忙碌跳过（§4.6）。
7. Task `f5609ce7`：级别切换：后继规则落到五个加载点与 `verified_record`；上调即时（含在途检查）；下调挂起、全部新 submit 与 `begin` 拒绝、撤回与提交失败自动撤回；变窄的重连改走下调并去掉其空闲门（§4.7）。

**回退**：每步可恢复原函数定义并回滚 Worker。第 4 步回退时，`prepare` 与 authority 中的复核检查、I11 触发器、I9 结案与三个复核出口都保留不回退（否则已有的复核标记无人执行、也无法清除）；`conflict` 终态在旧版本中按 `attention_required` 展示。第 2 步写入的摘要不回退。第 6 步回退时恢复空闲门与刷新触发器。

## 6. 风险与回退

| 风险 | 缓解 |
| --- | --- |
| 把已生效误判为未生效，导致重复写入 | I0–I3；新建用预生成 ID；写后谓词带标记；308 不判未生效；冲突从不自动重试；旧 attempt 不判未生效 |
| 去掉祖先版本后漏掉分享变化 | 第 2 步先补齐含角色的访问摘要；回填只在同一响应的版本未变时写入；匹配顺序访问摘要 → 分享摘要 → 版本；I10 |
| 把写入者绑定路径中已写 Drive 的操作误判为未生效 | I9 (a) 只覆盖数据库强制先记 attempt 的路径；其余一律冲突并复核；出口受 I12 终止门约束 |
| 写入者绑定路径的新建文件被移出目标槽后经认领登记 | 残余风险；B 部分在写入者 API 增加数据库 attempt 动作后排除 |
| 去掉版本后漏掉目标对象的变化 | 目标对象保留自身 Drive 版本前置条件 |
| 根目录被结不了账的作业永久锁住 | I9 只依赖数据库，覆盖所有 `auth_mode`：storage job 的未尝试 journal 与 prepared 释放，写入者绑定路径的 journal 结案为冲突（不释放为未生效），不受撤销、策略、纪元、凭证影响；**目录移动除外**，仍由 Owner 原生恢复 |
| 凭证规则扩大授权 | 纪元按明确的列迁移递增；执行器写入要求纪元相等；只读核验只读 |
| 级别上调规则被利用 | 后继条件逐项相等、能力只增不减、链中无收窄；在途不满足时转挂起 |
| 级别下调期间旧作业继续执行 | 挂起期间全部新 `begin` 拒绝；只等待切换前的 intent；Owner 可撤回 |
| 复核标记被绕过 | 在 `prepare` 与 authority 强制；目标槽与子树检查；所有写入路径经过或停用；I11 触发器；回退时保留 |
| Owner 永久删除刚新建的文件，被记为未生效 | 残余风险；变更流上线后排除（Task `e58aca14`） |

## 7. 验收

- 新建、改名、移动、替换、回收站在「已生效 / 未生效 / 冲突」三种 Drive 状态下按时结清；I2 时间门之前永远不会判未生效。
- 连接撤销、Owner 断开、策略变化、变窄重连之后，在途作业（目录移动除外）在 I9 上限内结案，storage job 中未尝试的 journal 与任何路径的 prepared journal 在准入过期 60 秒后释放，写入者绑定路径的 started/uncertain journal 在 I9 上限内结案为冲突并进入复核，根目录不被永久锁住。
- 写入者绑定路径的 journal 已写 Drive 但没 finalize 时，永远不会被判为「未生效」。
- 同一目录里出现与作业目标无关的变化时，在途作业照常完成；分区或父目录的分享被改动时，写入被拒。
- Owner 在作业期间改名、移动、删除已登记祖先，作业落入冲突而不是登记到错误路径。
- 凭证在作业运行中刷新，作业照常完成；撤销或换账号后执行器不再写入。
- 级别上调不等待；下调在上限内生效或由 Owner 撤回；任何时候被移除能力类的作业都不会执行。
- 冲突对象在复核前不能经任何写入路径被再次写入，也不能被目录移动、移入回收站或改名到其目标槽绕过；复核标记只能由三个出口清除，三个出口都有 Receipt。
- 摘要回填遇到版本已变的目录时标为「摘要缺失」，不写入摘要；已有分享摘要的目录不被回填、仍按分享摘要匹配。
- 隔离中的新建文件，只要仍在原目标槽或数据库知道其 Drive ID（cloud 路径的预生成 ID），就不能经认领登记后再写入。写入者绑定路径的新建在数据库里没有预生成 ID，文件被移出目标槽后无法识别：列为残余风险（§6），由 B 部分在写入者 API 增加数据库 attempt 动作后排除。
- 写入者绑定路径的冲突：本地写入者在根目录解锁后醒来再写，不会产生重复文件——目标槽在 I12 证据齐全前一直被隔离占用。
- 文件系统适配器写入本地、同步客户端离线：Owner 只证明执行器终止与 Drive 上不存在时，出口拒绝；补上本地效果已了结的证明后才放行。
- 文件系统适配器的删除已在本地执行、同步离线、Drive 上文件仍在：「本地目标路径不存在」不被接受为本地效果已了结（删除的源路径未回到写前状态）；只有本地文件恢复或同步已停且已对齐后，出口才放行。
- legacy 模式 cloud job 未记录 attempt 而卡在 started：`expires_at + 10 分钟 + 2 小时` 之后的第一次定时扫描结案为冲突，根目录解锁。
- 文件系统适配器删除了本地文件、同步客户端暂停并记下待同步的删除，Owner 再从 Drive 网页把文件拷回本地：同步客户端仍有待同步变更时出口拒绝。
- 写入者绑定路径的写入已落地、`finalize` 丢失：撤销绑定并证明终止后，「已生效」出口登记观察到的文件，无需不存在证明；复核标记清除，子树恢复可移动。
- 今天两起事件（BUG-20261008-001、002）回放通过。

## 8. r1–r3 审核处理（A 部分相关）

| 审核项 | 处理 |
| --- | --- |
| r1 A1、r2 N7、r3 M-2 级别切换 | §4.7 |
| r1 A2/B2、r3 M-1 结算钉住登记表 | §4.2 末项、§5 第 3 步：`settle_verified` 祖先按身份比对 |
| r3 B-1 Drive 祖先版本进入准入凭据 | §1.2 第 4 条；§4.2 |
| r2 N1 Drive 祖先链核对 | §4.2 |
| r1 B1、r2 N10 时间门与措辞 | I0–I2、I8 |
| r1 B6、r2 N9、r3 m-7、m-8 凭证 | §4.6 |
| r1 B7、r2 N8、r3 M-3、m-4 冲突与复核 | §4.4、I9 |
| r1 B8、r2 N11、r3 m-1 续传 | §4.5 |
| r3 M-5 刷新触发器 | §4.6、§5 第 6 步 |
| r3 m-6 修订 SFC 规范文字 | §0 |
| r3 n-2、n-3 写后谓词、核对成本 | §4.3、§4.2 |
| r2 N15、N16 | I3；§4.3 残余风险 |

## 9. r4 复审处理

| 复审项 | 处理 |
| --- | --- |
| BLOCKER-1 没有摘要的目录失去分享防护 | §1.2 第 6 条；§4.1 与第 2 步摘要补齐先于去掉版本；I10；摘要缺失的目录继续按版本 |
| BLOCKER-2 冲突结案没有上限 | I9 只依赖数据库的结案；只读核验的凭证规则（§4.4）；纪元相等只用于执行器写入；变窄重连按下调处理 |
| MAJOR-1 后继规则与策略表不符、加载点为五个 | §4.7 逐字段定义，/2→/3 条件，只要求后继为 `native_level_change`，五个加载点与收据字段，在途不满足时转挂起 |
| MAJOR-2 下调可能饿死 | §4.7：挂起期间全部新 `begin` 拒绝，只等待切换前的 intent，上限为 I9 |
| MAJOR-3 去掉目标对象版本改写了 SFC §6.1 | §4.2：目标对象保留自身版本；§0 写明不修订 §6.1；语义字段只用于结算 |
| MAJOR-4 复核标记只在 submit 与 load 检查 | §4.4：在 `prepare` 与 authority 强制；`load` 拒绝以 `denied` 结案；回退时保留 |
| MAJOR-5 第 2 步不能单独上线 | §4.2 版本消费者清单；第 3 步一次改完（含 authority 与 `settle_verified`）；认领与目录移动保持不变 |
| MINOR-1 refresh `due` 忙碌跳过 | §4.6、第 6 步 |
| MINOR-2 纪元事件定义 | §4.6 按列迁移定义；谱系拒绝不递增 |
| MINOR-3 上线前已开始的 attempt | §4.3 |
| MINOR-4 会话地址的存储与 Receipt | §4.5 只追加字段、专用 RPC 与 Receipt |
| MINOR-5 GA1 范围 | GA1 收窄并说明认领与目录移动 |
| NIT 加载点数量、I7 编号 | §1.2、§4.7 为五个；I7 标注移入 B |

## 10. 移交 B 部分（Task `e58aca14`）的意见

r1 B3、B4、B11、B12；r2 N2–N6、N12、N14、N17、N18；r3 M-4、M-6、M-7、m-2、m-3、m-5、m-9、n-4；r3 B-1 中「同目录并发写入」的部分；r4 复审「for Part B」各项（复核标记转为锁行、同一对象并发写覆盖标记、登记表身份写入与在途结算竞争、摘要回填与并发写竞争、并发与限速、目录移动子树互斥、跨根目录与跨账号的对象身份、去掉单写者后刷新 fence 的处理）；r7 复审 m2（写入者 API 增加数据库 attempt 动作，在写 Drive 前记录 `provider_file_id`）。

## 11. r5 复审处理

| 复审项 | 处理 |
| --- | --- |
| BLOCKER-1 回填等于批准当前分享状态 | §4.1：只有 Drive 当前版本等于登记版本才写入，否则「摘要缺失」；根目录锁、空闲门、行版本 CAS；读取凭证条件；Receipt 不是 Owner 批准 |
| MAJOR-1 连接断开后未尝试的 journal 无上限、legacy 路径 | I9 (a) 覆盖所有 `auth_mode` 的 prepared/started/uncertain；§1.3 写明现状缺口；第 4 步 |
| MAJOR-2 I9 不应结案目录移动 | I9 排除目录移动；§4.4、§6、§7 照此限定 |
| MAJOR-3 只读核验的凭证规则过宽 | §4.4：同一 owner、subject、client，连接根目录相同，无拒绝，请求前检查有效期 |
| MAJOR-4 后继链允许变化的字段未列、`verified_record` 未覆盖 | §4.7 列出七个字段；`verified_record` 同步改 |
| MAJOR-5 复核标记可经子树、目标槽、管理员写入绕过 | §4.4：目标槽隔离记录、子树检查、所有写入路径经过或停用；I11 |
| MINOR m1 I9 先试 `settle_verified` | I9 (b) |
| MINOR m2 第 4 步回退保留出口 | §5 回退 |
| MINOR m3 变窄重连在第 7 步前保留空闲门 | §4.6、§5 第 6、7 步 |
| MINOR m4 descriptor 与空值哈希格式、凭证钉住点 | §4.2 末两项；§4.6 钉住点清单 |
| MINOR m5 下调挂起期间拒绝全部 submit、提交失败自动撤回 | §4.7 |
| MINOR m6 摘要不含角色 | §4.1：新增 `provider_access_digest`（`googleDriveAccessDigest`） |
| MINOR m7 回填机制 | §4.1 专用 RPC 与定时任务 |
| MINOR m8 每次请求前检查有效期 | §4.1、§4.4、§4.6 |
| NIT 接入登记行号；会话地址独立列 | §1.2 第 6 条；§4.5 |

## 12. r6 复审处理

| 复审项 | 处理 |
| --- | --- |
| N1 BLOCKER I9(a) 会把写入者绑定路径中已写 Drive 的操作判为未生效 | I9 (a) 收窄为数据库强制先记 attempt 的 storage job 与 prepared；写入者绑定路径的 started/uncertain 归 I9 (b) 冲突加复核；§1.3 两行与正文更正；§6、§7 |
| N2 MAJOR 有分享摘要的目录被降级为按版本 | §4.1 匹配顺序访问摘要 → 分享摘要 → 版本；回填只针对两种摘要都没有的目录；identity 继续输出分享摘要 |
| N3 认领在 I9 (b) 被误判冲突；引用过时 | I9 (a) 沿用认领补丁规则，I9 (b) 排除认领；§1.3 引用 `20261002200000…:410-424` |
| N4 认领绕过隔离 | §4.4 按 Drive 文件 ID 与认领目标槽检查；§7 |
| N5 目录检查不能写访问摘要 | §4.1、§5 第 2 步扩展观察合同 |
| N6 回填的读取与事务、版本与权限一致性 | §4.1 两段式、同一 `files.get` 响应、提交时复查；写明版本相等的含义 |
| NIT §4.6 与 GA3 的目录移动限定；I11 出口凭据 | §4.6、GA3；I11 与 §4.4 绑定出口 Receipt |

## 13. r7 复审处理

| 复审项 | 处理 |
| --- | --- |
| M1 MAJOR 复核出口可在写入者仍能写时判「不存在」 | 新增 I12 终止门（沿用 `fenced_no_effect` 的三项证据）；§1.3、I1、I2 写明写入者绑定路径不满足 I1/I2；§4.4 出口；§7 验收 |
| m2 写入者绑定新建没有数据库预生成 ID | §7 收窄并列为残余风险（§6），交 B 部分 |
| m3 I9 (a) 去掉两个谓词条件未说明 | I9 (a) 写明放宽与理由；第 4 步回归测试 |
| n1 cloud 写入者令牌可置 `uncertain`；§6 措辞 | §1.3、§6 |

## 14. r8 复审处理

| 复审项 | 处理 |
| --- | --- |
| N1 MAJOR 证据不覆盖同步客户端排队的上传 | I12 第一层对基于本地路径或经同步到达的绑定另需 `local_effect_settled_after_termination`；§7 离线同步用例 |
| N2 MAJOR I12 让已落地写入无法结清 | I12 拆两层：所有出口需撤销、终止与终止后观察；只有「不存在 / 未生效」另需不存在证明；§4.4 写明迟到 `finalize` 被拒、经「已生效」出口登记；§7 用例 |
| m3 剩余 v1 并不要求 `account_policy` | I9 (a) 理由只依赖 `for update`、`state='started'`、`provider_attempt is null`；回归测试断言恰好这三项 |
| N3 写入者绑定路径的 I9 (b) 时限引用了不适用的 I2 | I9 (b) 直接写出 `expires_at + 10 分钟 + 2 小时`，并说明它不是 fence |
| N4 legacy 模式的 cloud job 归属 | 新增「路径划分」：attempt 由数据库记录的 storage job（v1 或 v2）都属 cloud 路径；I12 不涉及共享的 cloud 写入者绑定 |

## 15. r9 复审处理

| 复审项 | 处理 |
| --- | --- |
| MAJOR-A 「本地目标路径不存在」让本地删除、移动被误判未生效 | I12：本地效果了结要求操作涉及的每个本地路径都回到写前状态（「不存在」只对新建目标成立），或同步已停且已对齐；§7 离线删除用例 |
| MINOR-B 数据库不记录绑定种类 | I12：本地效果证据对写入者绑定路径所有出口一律要求 |
| MINOR-C legacy 模式 cloud job 未记录 attempt 时无规则 | I9 (b) 改为兜底，时限 `expires_at + 10 分钟 + 2 小时`；§7 用例 |
| m3 NIT 回归测试口径与行号 | I9 (a) 理由与测试改为 `for update` 下 `state='started'`、重放不允许执行；行号更正 |
| NIT-D §1.3 的 legacy | §1.3 写入者绑定路径一行改为「不经 storage job 的 legacy 写入」 |

## 16. r10 复审处理（PASS 后的收尾）

| 复审项 | 处理 |
| --- | --- |
| MINOR-1 同步客户端按变更队列重放，本地文件状态不够 | I12 本地效果证据两种情况都要求同步客户端在该根目录下没有待同步变更；§7 用例 |
| NIT-1 行号 | `20261002170000…:45`；v2 `:139-141` |
| NIT-2 §7 与 I9 (b) 的时限措辞 | §7 改为「之后的第一次定时扫描」 |

## 17. r10.2 后继提案：常规故障由程序自动核对与恢复

### 17.1 状态、来源与本轮范围

**状态：PROPOSED，待独立审核与正式接受。** Owner Decision `09ae2493-e980-49ef-a0ea-de552a42d1d9@3` 明确常规故障应由程序自动检测、核对、结算恢复，不能把常规收尾转交用户点击或 Agent。这是产品方向与本次实施范围的来源，不是对本节具体算法、代码、全部 A4 或生产上线的接受证明。r10.1 的接受状态与 §8–§16 审核历史保持不变。

本轮仅覆盖：已登记 `storage_jobs_v1`、原身份可证明、`authority_snapshot_v2` 非空且原 cloud writer binding 一致的 **单文件 `replace`**；包括从 Native 入口产生、但保留这一相同服务端来源形态的作业。须有真实原 attempt 与回执、I9 已生成完整稳定对象范围的有效隔离、原连接/Owner/Google subject/client/root 一致。未登记 job 的 writer、无快照 legacy、目录/子树、其他操作、scope 不完整的对象不因本提案获得自动基线出口。

I0–I5、I8–I10、I12 以及运行中的根目录 single-writer 与短事务 root 锁不修改。**I2、I9 的时间门与 I12 的终止证明不缩短、不移除**；本轮不是 B 的运行中对象级并发交付，也不表示 A4 全部完成。其余 A4、非 job/legacy 出口与 B 继续原任务后继。

### 17.2 对 I6、I11 与旧 attempt 规则的窄修订

以下规则只在本后继正式接受后、对 §17.1 的合格作业适用；不能反向声称 r10.1 已接受这些新行为。

| r10.1 位置 | r10.2 候选规则 |
| --- | --- |
| I6「冲突只记录、不自动修复」 | **不自动改动外部内容**。程序可以核对当前状态并用独立回执结束服务端隔离；不得为达成期望状态而补写、覆盖、恢复、删除或重派原未知效果。真实不同内容才保留可选的 Owner 取舍。 |
| I11「只经三个复核出口」 | 合法出口新增服务端 **当前基线自动核对恢复**，与原 after 核验结算、真正冲突的显式取舍并列。自动清保护必须由同一事务内的独立 `storage_automatic_reconcile` Receipt 与私有 permit 绑定，保留全部不可绕过的隔离触发器；事务变量、客户端报告或 `confirmed:true` 不能替代。 |
| §4.3「上线前已开始的 attempt」 | 缺标记或完整历史 `content_before` 时仍不判历史「未生效」，不改写为 `cancelled`/`committed`。若原 authority、当前有效登记与 fresh 观察的稳定 ID/原版本完全一致，可得出较窄的「当前登记基线一致」并独立结束隔离；原未知写入历史保留。 |
| §4.4「Owner 原生页面复核出口」 | 常规 before 的收尾由后台程序完成，不要求页面、用户确认或 Agent。只有经真实核对后与登记基线不同的当前内容才开放可选取舍；页面是状态展示与真正冲突的可选入口。 |

「当前与原登记基线一致」不等于证明原写入从未发生，也不保证外部服务以后不会出现迟到变化。原 journal 的 `conflict`、I9 回执、attempt、attempt 回执及既有 proof 保持真实历史。新的正常作业仍重新取得当前对象身份/版本与正常授权；不得因独立恢复而跳过准入。

### 17.3 服务端三出口与判定流程

| 真实核对结果 | 程序行为与公开状态 |
| --- | --- |
| 期望 after 成立 | 继续原 `verified_record` → `settle_verified`。只有原完整核验器接受的 after proof 才可把原操作登记为 `committed`；不得用 before 自动回执替代。 |
| 当前仍为原有效登记的精确 before 基线 | 服务端自动产生独立 Receipt/Event、解除这一原隔离，公开 `resolved` / `automatically_reconciled_before` / `automatic_recovery=resolved`。旧操作仍 `conflict`，不声称 `replace COMMITTED` 或历史 no-effect。 |
| 真实当前内容不同，或事实仍不明 | 事实仍不明保持 `pending`，后台按有界退避继续；稳定不同内容公开 `current_state_conflict`，保持隔离并允许显式选择。读取失败、失效凭证、版本竞争或未知回复不得转换成成功。 |

自动 before 出口必须同时满足：

1. **原来源与当前授权**：同一原 job/intent、Owner、connection、Google subject、OAuth client、root、原 cloud writer；同应用有效 issuer；当前账户可用、连接未撤销，原 policy 仍当前且有效，auth generation、policy generation、scope digest、profile/决策版本满足 CAS；原 client 与 root 均无 deny。只读凭证在每次 GET 前仍有至少 60 秒有效期。仅可使用现有授权的同 job 限次刷新；不得开启续签、恢复已停止委托、扩大 scope 或绕过失效授权。
2. **范围与时间**：原 I9 隔离完整，唯一稳定文件 ID、名称槽、父级与祖先覆盖成立；原 effect 已过既有 I9/最长请求时限，另核对真实 attempt Receipt 的时间。没有完整范围、仍有运行中可发送效果或尚未到时间门时，不得自动清保护。
3. **fresh 双 GET**：Worker 只对原对象做两次真实 Google 元数据 GET，同时核对父目录/祖先身份与原名称槽；两次独立记录完成时间，语义字段完全相等。提交事务时第一观察距服务端时钟不超过 30 秒，第二不早于第一且无异常未来时钟。禁止从浏览器、缓存或 Agent 自报事实构造观察。
4. **稳定基线**：原 authority 的 ID/Drive version、当前 active 登记的同 ID/版本、两次 GET 的 ID/版本一致；文件类型、trashed、名称、父 ID、当前合格父登记与祖先链均符合。原 attempt 有 size/hash/head revision 时逐项强比；历史缺少这些字段不能虚构证据，也不能把较窄的基线一致表述为历史无效果。Drive `files.version` 为每次服务端变更递增的版本依据，参见 [官方 Files 资源](https://developers.google.com/workspace/drive/api/reference/rest/v3/files)。
5. **事务与优先级**：原 job 锁、短事务 root 锁、journal/隔离/登记行版本与原 I9 source Receipt 绑定同一 CAS。若真实 after proof 已登记，候选 before 出口必须拒绝，让原结算优先；两会话竞争最多生成一个自动恢复回执。最终 Receipt、Event、隔离解除与版本推进同事务提交，任一失败全部回滚。
6. **历史与读取投影**：旧 journal 不改为成功或未生效；只增加独立 resolution 及其 Receipt 引用。公开成功必须带正 `base_version`、原 `source_receipt_id`、与 source 不同的新 `receipt_id`。普通 MCP inspect 保留旧操作的 `attention_required`，用 `PROVIDER_RESULT_RECONCILED` 与独立 resolution 引用说明保护已解除，不能继续报成待处理旧冲突或伪造旧写入成功。

Google 请求只查询状态与元数据，不盲重试未知非幂等写入；读取失败有界重试/退避遵循 [上传状态查询指南](https://developers.google.com/workspace/drive/api/guides/manage-uploads) 与 [错误处理指南](https://developers.google.com/workspace/drive/api/guides/handle-errors)。观察时间与数据库 CAS 构成有限证据窗口，不构成 Google 跨系统事务。

### 17.4 §5 实施、正常入口与回退补充

- 以新 successor migration `20261016090000_storage_automatic_reconcile_v1.sql` 承载候选，不能改写已生产 I9 迁移。复用现有私有 issuer 路由 action 与现有调度权威；不新增 public RPC，不扩大 GW80/CI8，克隆 helper 与技术观察表不得授 API 角色直调/读写权限。
- 真实后台 scheduled recovery 加载原合格 job 后执行上述双 GET 与原 CAS。正常经过认证的 submit 若因 `storage_object_under_review` 提前拒绝，可唤醒既有受限 due 扫描；不得为唤醒创建新 queued job，也不得把客户端任意 job/Owner 引用提升为 issuer 代理权限。原 job 的 inspect 可以同样触发受限检查。唤醒只能返回真实状态或重试提示，不能把排入后台当作已经恢复。
- 页面只列出/轮询服务端状态；常规 `pending` 不要求用户点击「核验/采纳/放弃」，不依赖打开页面或 Agent 持续操作。真正 `current_state_conflict` 的可选取舍仍使用 fresh 服务端核对、精确 CAS 与显式确认。
- 同一稳定目标 ID 的两次真实观察已证明外部改名、移位、回收站状态或同名占位，但新名称槽/父级/祖先边界不合格时，必须持久显示 `current_state_conflict`，不能因核验提前拒绝而永久伪装成 `pending`。此类观察只开放安全的显式放弃登记与后台重新核对，`review_available=false`、`abandon_available=true`；不得据此采纳不合格新位置。读取失败、403、目标身份无法证明或双观察不一致仍保持未知，不假造真实冲突或成功。
- 生产前分别验证迁移应用、自动调度与正常入口接线、实际 issuer/client 来源、公开投影和回执。候选本地通过或 schema 可载入不是发布证据；既有 I9 scheduler 的硬性激活条件保持。
- **回退**：可停止新的自动 before 尝试并恢复 Worker 读取路径；已写入的独立 Receipt/Event、旧 journal 历史、resolution 投影、I11 permit/触发器与安全出口必须保留。不能回退成全局放行、删除隔离或重派旧效果；不得回退已生产 I9。after 仍走原核验结算，暂时无法核对的作业保留真实 pending/隔离及有界后台重试。

### 17.5 §6 风险与 §7 验收增补

| 风险或用例 | 必要断言 |
| --- | --- |
| 当前仍 before，历史缺完整 content_before | 以真实 Worker 双 GET 接真实 PostgreSQL RPC；精确 ID/版本及当前登记成立才生成独立自动回执，原 journal/attempt/I9 回执仍在，不伪造 no-effect。 |
| 两 GET 间变化、读取失败、scope 不全 | 不调用成功出口或事务拒绝；不得成功、重写 Drive 或替用户确认。scope 不完整不获得此自动权限。 |
| 真实不同内容、真实 after | 不同内容保持隔离并开放可选处理；after 继续原 verified 路径。已保存 after proof 使旧 before CAS 失败；after 最终结算仍保留原完整 proof。 |
| stale/篡改/错 Owner、issuer/client、版本、source Receipt、凭证、拒绝/撤销/策略失效 | fresh proof/CAS/现有授权门拒绝；零新增 provider effect，不能借其他连接或应用的凭证。 |
| 双连接同时自动恢复、未知回复 | 实际两个数据库会话竞争最多一张自动回执；未知回复只检查原 job/回执，不重派旧写入，不把未知当成功。 |
| 最终回执失败 | 真实故障注入后隔离、技术观察、版本、Receipt/Event 同事务回滚；保护仍有效。 |
| 自动恢复之后正常使用 | 同一对象的新正常作业可按当前授权准入；无关对象/root 不被恢复检查升级成全局锁；旧 journal 未伪造 committed。 |
| UI、Agent 退出 | 后台仍会自动核对；正常入口可有界唤醒且原重叠 submit 不新建 queued job。页面仅展示 pending/resolved/真实 changed，不承担常规结算。 |
| 权限与回退 | GW80/CI8 不变，新 helper/table 无 API 直调；I11 无旁路；回退保留真实历史、独立回执与保护，不能自动恢复停用续签或权限。 |

本节的测试、独立审核、Owner 对具体后继的正式接受、合并与生产验收是分别记录的事件；尚未发生的步骤不得标为完成。本轮只修复 §17.1 的常规恢复链，不替代 r10.1 的其他交付，也不宣布 B 的并发目标达成。

## 18. 新 cloud attempt 的完整语义恢复（Task `e91a8ebc`）

本增量落实 §4.3 的新建、改名、文件移动、替换、单个文件或空目录的回收站操作。启用点是服务端从原 sealed credential context 取得的实际 OAuth client；不是工具参数、显示名称或浏览器传来的权限。目录移动、认领与既有无新证据的 attempt 沿用原恢复路径。

### 18.1 原子记录与一次效果

- 原 provider attempt 及其 Receipt 不变。首次 `provider_attempt` 成功时，同一数据库事务另存不可变的 `clued.storage-semantic-attempt/1`、原 attempt Receipt/digest、完整 before、服务端重新计算的 after 谓词和实际 client。任一验证失败，两份记录一起回滚；重放不补录历史证据，也不允许再执行效果。
- 新建沿用预生成 ID 与原 private marker；其余操作在原本的一次 PATCH 或替换 multipart 请求内设置 `appProperties.clued_intent_id`。不增加一次事后标记请求，不重派回复未知的原效果。
- 普通成功与后台恢复都先取得 fresh 同 client 的两次稳定目标观察、前后完整祖先身份及名称槽观察。目录目标的 before 同时保存同一元数据响应中的完整权限摘要；权限缺失不能作为相等。
- 观察不续签、不授权、不调用模型或 Drive 写入。每个读取有超时，整个观察有截止；权限、限流、网络和格式失败保持真实原因并由原调度退避继续。

### 18.2 数据库重新判定

私有结算入口重新验证 Owner、原 job/intent/request、client、原回执、当前凭证与授权、完整 scope、观察时效及版本，独立推导结论，不接受 Worker 的分类字符串作为证明。

| 当前观察 | 程序处理 |
| --- | --- |
| 完整 after、自己的 marker、稳定版本与名称槽 | 与原类型核验 proof 同事务保存独立验证链接，再走原 `settle_verified`；I9 结算也必须有此链接。 |
| 完整 before、名称槽一致、已过 I2 | 原在途 journal 取消为 `PROVIDER_EFFECT_ABSENT`；原 I9 冲突则保留历史 conflict，通过独立自动恢复 Receipt 与 I11 permit 解除该对象保护。 |
| 新建 ID 返回 404 | 仅是缺失观察，仍须同 client、具备命名空间读取能力的 private marker 搜索也为空；401/403/5xx 不解释为缺失。 |
| 同名外部对象、权限或内容改变等真实差异 | 该对象继续真实 conflict；不改外部文件，不显示“已恢复”，不占用无关对象的写入资格。 |

I2 未到时，只有完整 after 可以结算。名称槽有变化的两次读取、祖先变化或证据不完整时不产生结论。旧 attempt 不由本增量倒推历史 no-effect。

### 18.3 恢复后可继续使用

before 的语义相同可能伴随 Drive version 前进。仅在原登记行身份、路径、类型、状态和旧版本 CAS 均成立时，与恢复出口同一 Receipt 更新该行版本。目录还须与记录 before 时的完整权限摘要相同；不能用内容/名称相同接受新的权限基线。并发恢复最多提交一张出口 Receipt，重放只返回已提交结果。

替换的 before 核验另外读取原 revision 的真实 `keepForever` 与内容元数据，只登记实际存在的 pin；不重新上传、不解除 Owner 保留。已存 after proof 优先，任何失败不得清除原 proof、Receipt 或隔离。

Native 的 `resolved` 响应包含精确 connection/job、新 Receipt、不同的原 `source_receipt_id`、正 `base_version` 与 `automatically_reconciled_before`。页面只展示程序结果，正常恢复不增加用户确认步骤。

### 18.4 验收与后继边界

本增量要求先真实 PostgreSQL 路由回归，再核原生页面与接口；合并、迁移及同 cohort 全量发布分别保留证据。回退可关闭新语义尝试，原不可变 sidecar/Receipt、I11、安全出口与已提交恢复结果保留，不重派旧效果。

Task `e91a8ebc` 继续承担 legacy/null-snapshot 与非 job I9/I12 完整出口、替代合法只读连接和其余非目录移动目录复核范围；这些不由本增量的测试宣告完成。Task `2e439b59`、`300dcbd0`、`f5609ce7`、`e58aca14` 分别保留 §6 的续传、授权纪元、级别切换及 B 并发范围。已暂停的新域验收与退旧域保持暂停。

## 19. I9 旧模式与非 job 的到期结案覆盖（e91 后继候选）

本增量补齐已接受 I9 的到期分类入口，不改变 I1/I2、I11/I12 或证明含义。资格依据是原 journal 与同 Owner 的原 profile；不把当前账号策略、OAuth 连接是否仍有效或 `authority_snapshot_v2` 非空作为停止旧作业占用的前置条件。

prepared 仍只在到期 60 秒后安全取消，不生成未知效果的隔离。started/uncertain 沿用原候选机制：数据库强制先记 attempt 的路径按原规则判定，其余旧模式与非 job 在 I9 上限后以 conflict 结案并登记对象、路径、名称槽和必要子树；不能因数据库没有 attempt 就断言一个未受控写入者没有产生效果。原 verified proof 优先、回执与 Event 原子性、退避、有界扫描和目录移动/认领例外保留。

同一父目录的 rename 若只漏存 `source_parent_id`，可从不可变原请求的两个路径拥有相同父路径、且原 destination parent 已有身份这两项事实恢复源名称槽。跨父目录或原范围仍不完整时不使用当前登记行猜测；原物理范围保护继续有效。完整范围内的异常不扩大为其他对象的禁用。

I12 的撤销、终止和本地同步效果证明没有被本增量删除或伪造；不把一次普通取消当成这些证明。非 job 的完整原生核对出口、可替代的合法只读连接及剩余目录核对仍属 e91 未完成范围。此节及其数据库测试不表示这些后继或生产发布已完成。

## 20. 原连接退休后的合法只读核验（e91 后继候选）

§4.4 的核验凭证与原写入授权分别校验：原 journal、job、attempt、typed proof、Receipt、Google subject、OAuth client、原 root 与 profile 身份保持；只在当前 Owner 的同 subject/client/profile/root 有合法有效连接时，以该连接做 GET。新连接的 profile、policy、Decision、拒绝记录、凭证和版本必须在服务端重新校验，不继承原写入者、旧 policy generation、旧 auth generation 或执行资格。每次 GET 的有效期下限仍为 60 秒。

服务端返回独立 `clued.storage-recovery-reader/1`，包括实际读取连接、连接/凭证版本、授权 generation、policy 身份/generation/scope digest 与 profile version。Worker 只能用该读取连接的真实 vault AAD 解封；原 job 的 `connection_id` 仍是原历史身份。结算事务重新检查同一 reader，发生撤销、换账号/client、root/client/read deny 或版本变化就拒绝，不改写物理效果。

执行与结算入口按原 client lineage shared guard → job → root 顺序进入，Owner client/read deny 使用同一 lineage 的 exclusive guard，不能在撤销已提交后继续提交旧核验结果。多作业 Native 列表仅作无执行锁的当前资格投影；真实 load/settle 重新完整核对。I9 扫描在已经处理其他候选时不等待新的 lineage/job/root/object 执行锁，忙对象留给后续有界扫描，不能以忙或超时伪造结案。对象锁在候选 Receipt 开始后遇忙时抛出受控异常，使整个候选子事务和 pending Receipt 一并回滚，不能返回一个悬空回执。

before 仍经原双 GET、I2/I9、登记与 I11 出口；新 reader 及实际凭证版本写进独立恢复回执。after 仍经过原完整 typed verifier、原 admission/attempt/Receipt/registry 与语义证明链；reader 不能跳过 proof 形状、原 revision 保留或 CAS。实际 reader 记入不可变持久化 proof，之后按原 `settle_verified` 结案。观察表只在首次 INSERT 时记录 reader，不能事后改写不可变观察。

当前连接的原生作业列表可列出同 Owner、同 profile/subject/client 且当前只读资格仍成立的旧连接作业。每行保留原 `connection_id`、job 和 Receipt；单独的 `read_connection_id` 只绑定当前页面上下文。页面继续只轮询状态，原作业的真正冲突取舍仍发送原 connection/job 与原 CAS；页面刷新、换账号、上下文变化或旧版本消失均作废已展示的选择。列表不向页面公开凭证或 reader 内部授权细节，旧授权不因列出而恢复。

实际 reader 的凭据过期时，恢复程序以原 job 产生续签需求，复用既有 recovery-only 单次 token exchange、凭据 CAS 和回执，不等待该连接碰巧出现新作业或 30 天 idle keepalive。刷新接收者是私有 descriptor 指明的当前 reader，`recovery_job_id` 仍指原作业。服务端重新加载原恢复资格，将原 connection/job/intent/request/attempt 与完整 reader 版本和策略摘要一并钉在 refresh attempt digest；claim 与 commit 均校验这条侧链。当前 delegation 停用、Owner/root/client/read 拒绝或版本变化仍拒绝；不重开旧连接或开启续签，不重试不确定的 token exchange。续签后重新加载原 job descriptor，再走原只读核对与结算。刷新入口也先取得原 client/job 锁，避免先持 root 再等待原 job。

此候选仍须正式源审核、合并、生产迁移与数据库先于页面的验收；非 job I12 的完整 Native 出口和剩余目录复核仍须分别交付与验证。生产 PR864 的应用时间版本 `20261017061135`、源文件 `20261017043050_storage_semantic_recovery_v1.sql` 与文本哈希在台账中如实绑定。不能把候选本地测试、台账补记或已上线 PR864 表述为整个 e91 完成。

## 21. 旧 P5 目录的程序基线核对（e91 有限后继候选）

没有 §18 语义 sidecar 的原 cloud writer 目录 trash/untrash，可由程序核对原 before 基线并解除该旧操作的 I9 隔离。原 job 必须仍绑定原 Owner、profile、writer、完整隔离、单一固定 Drive ID、journal/I9 回执与 CAS；完整原 attempt 必须精确等于既有 `storage_destructive_attempt_v1` 推导值。先校验当前只读 reader，保留 §20 的原 job/实际 reader 及单次续签桥，不能把空历史 snapshot 回填成一张新授权。

程序做两轮真实 GET，逐轮检查原 ID、父目录与祖先、名称槽、trash/explicit-trash、目录类型、完整访问摘要、分享摘要及包括回收站子项的空目录状态。目录没有文件内容大小、内容哈希或 revision。原权限摘要存在就比较；缺失时不猜旧 ACL，before 仍要求 Drive 版本精确等于原版本。delete-before 是原 active、未入回收站且名称槽唯一指向原 ID 的目录；restore-before 是按 ID 读取的原 trashed 目录且恢复名称槽为空。restore-before 恢复的是正常使用能力，不能显示成已经将目录移出回收站。

提交事务继续按 client → job → root 进入，重新检查实际 reader、凭据、原 profile/Decision、I2/I9 时限，以及源 Artifact 的原 ID、状态、路径、provider version、authority version 和当前 Decision。root、track 的路径与物理身份均不允许，active/trashed 登记后代也不允许；不新增目录移动、非空目录删除或跨目录改名能力。列表不取得执行锁，I9 扫描保持原非阻塞策略。

before 成立时只用独立 `storage_automatic_reconcile` Receipt 和同事务出口 permit 解除原隔离，原 conflict 状态、原 attempt/I9 Receipt、源 Artifact 及回收站状态均保留。并发两次核对只提交一张独立回执；回执失败全部回滚。after 仍需原 typed verifier/admission/proof/Receipt 完整结算，不能仅凭观察到 trash 位变化记为成功。changed 只记录具体核验冲突，不套单文件登记逻辑或改写后代路径。

目录 Native 当前状态取舍、空历史 snapshot 的 after 完整链，以及非 job I12 的可信终止/本地效果/同步队列证明链仍由 e91 后继分别实现和验收，不用合成 booleans、通过 before 的测试或本候选归档宣告完成。G 盘后备和暂停范围不因此启用。

## 22. I9 旧创建任务的自动缺失核对（e91 有限后继候选）

没有语义 sidecar 的原 cloud writer 文件或目录 create，可通过当前合法 reader 读取原生成 ID，并用同 OAuth client、具备命名空间读取资格的凭据搜索原 intent 私有标签。只有原 ID 明确返回 404、标签搜索为空且完整、无下一页时才形成本次读取范围内的缺失证明；401/403/5xx、超时、`incompleteSearch` 或坏类型不等于缺失。不能由当前缺失反推旧请求从未产生过效果，也不重做旧 POST。

服务端仍要求原 Owner/profile/cloud writer/intent/request/attempt/原回执完全绑定，I9 冲突完整隔离且只有原生成 ID，原 journal 与关闭回执、版本 CAS 一致。实际 reader 与凭据版本在同事务复核。原到期时间和实际 attempt 回执均至少过去 132 分钟；原 journal 的 conflict 状态禁止后续派发旧效果。已登记的 active/trashed 同 ID、路径或目录后代均拒绝这一出口，不覆盖当前登记或重用单文件登记路径。

缺失核对只提交独立 `storage_automatic_reconcile` 回执和同事务 I11 permit，解除本任务隔离；原 conflict、attempt、原 I9 回执与文件登记保持。并发只形成一张新回执，回执提交失败时许可、隔离状态和 journal 版本一起回滚。实际 reader 身份、凭据版本、原 attempt 回执和本次缺失证明进入独立审计请求。私有 descriptor 的关闭版本与原冲突回执也必须与 Worker 收到的结果一致；没有该私有提示的旧 descriptor 不能声称走此 I9 出口。原 started/uncertain 缺失处理仍保留其完整原实现与校验，不扩公共调用角色。

本节要求真实 gateway→PostgreSQL 与 Worker 读取组合测试，涵盖文件/目录、同任务新授权操作可进入、非空搜索/不完整搜索、reader/CAS变化、并发与回执回滚；先数据库后页面验收。本文及本地测试不等于已合入、已迁移或所有剩余机制完成。真实差异和暂时无法读取继续由程序按原有界退避自动核对，保护只限已确定的受影响范围。

### 22.1 原生即时恢复与后台使用同一缺失出口

Owner 原生恢复接口与后台调度均接入相同的只读缺失探测和固定私有 RPC。恢复原作业时只重新读取，不重发 Google 创建或覆盖；两种入口使用同一 reader、版本与原回执绑定。I9 缺失核对成功须返回完整原作业定位、原回执、新回执、关闭版本和自动核对结果，供页面验证，而非仅返回“resolved”。若回执、版本或定位不匹配，不能显示已恢复，保留原状态及可诊断原因，由后续原作业检查继续。

原 started/uncertain 路径的内部 released_not_effected 结果在原生入口提交后，只再读取同一 Owner、同一原作业的实际状态一次，返回数据库已经提交的取消结果；不以内部标志虚构成功，不重复提交缺失或文件效果。文件和目录分别覆盖真实 Worker HTTP 入口、当前独立 reader、缺失正例、坏回执拒绝和旧取消出口。

## 23. 独立当前资格的程序登记（e91 有限目录增量）

原 before 基线缺失或版本已前进时，不能伪称旧授权、权限或原操作结果已核实。当前合法程序可以取得另一份当前登记资格：实际 issuer proof 的本次 credential generation、未撤销且启用的 app、原 client lineage 与 job/root、当前同 Owner/subject/client/profile/root 的 reader、当前 modify 和 full 策略、当前 Decision、runtime qualification Receipt/Event、账号总开关和 lifecycle 必须完整通过。旧 Agent Binding 过期不妨碍程序自身取得当前资格，也不复活旧 writer。DB 的 full 标记之外，Worker 必须以实际 reader 的完整 vault AAD 解封，并检查封存 scope 确属 full、有效期至少 60 秒。每次 RPC 重新解析 issuer proof；一次事务的 GUC 或上次返回的 JSON 不是下一次认证凭据。

本增量只处理 I9 已完整隔离且 I2/I9 终止窗口已过的原 P5 **active、ordinary、空目录**，保持原固定 Drive ID、路径、名称、单父、类型、governance、delete authority 与 source Decision。root/track 不是目标，active/trashed 登记后代不允许；目标本身和父链都要重新读取。它不移动目录、不恢复回收站对象、不删除文件、不处理非空目录，也不产生新的 provider effect。

### 23.1 从真实元数据建立新资格

从根到目标父目录的注册链必须连续、身份固定、Decision 当前；父链可以包含其他正常子项。两轮读取使用当前封存凭据，只做固定 Google Drive GET；首个读取之前开始计时，整个观察至提交须处于 30 秒窗口。祖先的 incidental provider version 可前进，但身份、路径、权限、名称槽及登记 CAS 必须稳定，目标版本则必须稳定。完整命名空间查询与合法分页是必要条件，不能把 drive.file 可见的空列表解释为空。

新资格暂限当前账号拥有的 My Drive 私有对象：ownedByMe、canShare、完整唯一 user/owner 权限、shared=false、同一个 Drive Permission ID 的 permissionIds 必须一致；明确请求并检查 published view、deleted/pending owner/expiry/domain/discovery 等权限事实。Permission ID 与 provider_subject 不作无合同的字符串等同。目录以 canListChildren=true 证明列举资格后，才可用包括回收站子项的查询证明目标为空；父目录不要求为空。已登记 access/sharing 摘要存在就必须精确匹配，不允许借“重新建立资格”接受明确的旧权限差异。缺失摘要由这次独立当前资格写入，旧缺失原因与旧行保存在新回执的 before_rows，不声称旧基线始终未变。

### 23.2 原子登记、并发与失败恢复

提交在 issuer/app → 原 lineage → job → root/account 后重读 Actor、完整计划、原 I9 回执和关闭版本，并以稳定顺序锁定相关 Artifact/Decision。master 已取得部分 Decision 锁后，其余全集必须使用 NOWAIT；遇占用使整个资格事务回滚并由程序退避，不能持有较高 ID 的锁等待较低 ID、与 Decision 替换事务形成锁环。任何锁等待后用真实 wall clock 重检凭据、策略和观察时限。仅目标及缺少 access 摘要的父链登记行发生资格更新；已有明确 access 摘要的无关父行不重写。scope digest 的路径/ID、grant、原 snapshot、原 attempt、原 conflict 状态和原回执不改。

元数据专用 permit 只能由私有提交路径在本事务的新 pending Receipt 下产生，精确绑定 transaction ID、Artifact ID、Owner/profile、完整 before/after row hash。触发器允许的差量仅为权限摘要、provider version、资格时间/缺失标记、Receipt、精确加一的登记版本和更新时间。跨事务、换对象、改路径、身份、状态、governance 或 delete authority 均不能借此豁免。它只排除“该目录恰好是另一个隔离对象的祖先”造成的元数据扩大冲突；其他隔离的同 ID、路径、名称槽、实际包含关系的 subtree 和未知 scope/I12 保护仍生效。

仍可结算的旧证明优先：prepared/started/uncertain，以及带有效 verified_result_v2 且 active I9 的 conflict，若依赖即将改变的祖先匹配模式或直接 Artifact authority version，则本次资格登记有界退避，先让原证明按原链提交；不得清空证明、重派效果或用全 root quiet 代替依赖检查。资格更新、全部受写 Artifact 的 base/committed versions 和 refs、Event、独立 Receipt、仅本 intent 的 I11 出口一起提交；最终 Receipt 失败使所有修改与 permit 回滚。重放仅返回已经提交且原定位/CAS/观察完全一致的新结果。

新结果为 `automatically_registered_current_state`，与 `automatically_reconciled_before`、原操作 committed 分开。它必须携带原 connection/job/intent、正关闭版本、不同的原 source Receipt 与新 Receipt、automatic_recovery=resolved 以及 execution_permitted=false；Agent、Owner 与页面分别按该合同校验，不能仅凭 resolved 展示成功。后台调度和 Native 使用同一程序，正常恢复没有 confirmed 参数或用户核对步骤。丢失提交响应只检查原作业；不重试 Drive 效果或新建替代作业。

### 23.3 真实验收与未覆盖范围

先真实 PostgreSQL 路由测试权限/撤销/双连接锁等待跨到期、完整 ACL、旧 typed conflict 优先、同父另一对象仍被独立保护、精确 permit 负例及 Receipt 失败回滚，再测 Worker 的封存 scope/AAD、GET-only、坏回执、超时、scheduled/Native HTTP 和页面投影。正常合并、迁移与同 cohort 发布后，先生产数据库、再页面、最后独立验收；本地测试与源码审核不表示上线完成。

本节未交付 legacy create-after 的 SQL adopt、trashed/非空目录当前登记、目录移动或非 job I12 的真实 executor 终止、逐路径效果与同步队列完整出口。create observer 的双私有标签/内容身份检查只是基础，不能当这些出口已实现。e91 整体仍须逐项交付验收，暂停的新域、旧域退役、G 后备和独立 backlog 不因本增量恢复。

## 24. 旧创建的独立当前登记（e91 源码候选）

程序先保留既有完整 typed proof 的正常结算机会。旧任务不能按原证明完成时，可以尝试新的当前登记资格；这不是对旧创建的授权或成功补签。原 journal 的 conflict、未 verified、原 snapshot（包括 null）、原请求、attempt 与原 Receipt 保留。程序不重新发送创建、覆盖或移动请求，也不新增用户确认步骤。

### 24.1 原任务与新权限分别核对

本出口仅针对固定原生成 Drive ID 的 cloud create、完整 I9 隔离和已过 132 分钟窗口的文件或空目录。服务端重新推导完整原 attempt，核对原 request、binding、内容身份、provider-attempt Receipt 的 canonical request hash、received hash、Event、I9 关闭版本与原定位。不能用目前的 policy、可变 grant 或调用者的布尔参数填回历史授权。

新登记使用当前真实 issuer generation、当前同 Owner/subject/client/root 的合法 reader、封存的 full scope、modify 与对应 create_file/create_topic 类别、runtime qualification 和当前 Decision。创建总开关 create_enabled/allow_base_create 单独检查；write_enabled 不能替代它。真实 clock 在等待之后重新检查。失效、撤销、换账号或策略变化时不登记。

目标是当前未被登记、处于 active 的固定对象；同 ID 在任何登记状态已存在时拒绝，不能借自动恢复重新接管撤销的对象。直接父目录须为已登记 ordinary 目录，目标不能为 root 或 track。两轮 GET 同时核对完整连续父链、名称槽唯一性、私有完整 ACL、稳定目标版本、两项私有 intent/request 标签，以及 MIME、大小和 SHA256；目录还须证明为空。原始读取前开始的整个观察与提交窗口不超过 30 秒。

### 24.2 原子登记与原历史分离

缺少 ACL 的现有父链仍经精确 metadata-only UPDATE permit 和原依赖保护核对；已有 typed proof 或在途操作依赖该祖先时退避。新目标通过普通 Artifact INSERT 护栏，不增加通用插入旁路。仅本 intent 在本事务 pending 独立 Receipt 下取得 I11 出口许可；其他对象、名称槽、子树和未知范围保护继续有效。

新对象固定为 ordinary、delete_authority=false。目录按现有模型保存目录权限摘要；文件的目录专属摘要列继续为 null，完整本次 ACL 证据保存在观察与回执中，不放宽数据库约束。新目标没有伪造的 before row：它在 Event 中有真实 created_target_id 和 after row，在回执中明确以新 Canonical ID 的 base 0、committed 1 与 target ref 关联；已存在父行仍保留自己的真实 before/after 和版本。

新对象、父链资格、Event、独立 Receipt、结果表和本任务隔离出口同事务提交。失败全部回滚；两个真实数据库会话只能提交一个新对象和一个恢复结果。丢失响应只查询原 job/intent 和已提交结果，不重派 Drive 效果。对外结果仍为 automatically_registered_current_state，不能显示原 create committed。

### 24.3 交付与验收边界

本节为源码候选，须经真实 PostgreSQL 路由与 Worker 测试、独立源码审核、正常 PR/当前 CI、合并和正式生产发布，再按数据库先于页面的顺序验收。旧 typed 路径仍可正常 committed 的情况，与新当前登记路径分别测试；故障注入的旧证明路由不可用不能冒称真实 null-snapshot 历史链已验证。真实历史入口、现有刷新分支、并发、回执失败回滚与权限反例的覆盖结论分别记录。目录其他状态、目录移动、非 job I12 和暂停范围不因本候选宣告完成。

## 25. Active 非空目录自身的当前资格（e91 后继候选）

本节仅修订 §23/24 中“独立当前登记”对物理空目录的要求，不修改原操作的 typed proof、原 before/after 判据或其优先结算机会。当前程序可以资格化仍为 active、ordinary、固定身份/位置的目录自身，即使该目录现在包含用户的文件或回收站子项。现有 plan 对 root/track、已登记 active/trashed 后代、已撤销对象及完整原 I9/attempt/Receipt 的限制继续适用。

目标与连续父链仍需完整当前程序授权、封存 full scope、私有且完整 ACL、唯一名称槽、目标版本与登记 CAS，以及 30 秒内的两次真实只读观察。`empty` 是本次实际观察到的布尔事实，可以为 true 或 false；缺失、null、字符串或两次不同仍拒绝。父链 incidental version 的现有语义、原明确权限基线和各项 scope/I11 保护不变。

资格只更新目录自身和原合同允许的缺失摘要父行；旧创建只插入该固定目录的一个 ordinary、delete_authority=false Artifact。目录中的物理子项均 **未被纳管**：不登记其 Artifact、不读正文、不改内容、位置或分享、不授予对其写入权，也不以目录资格声称完整子树已核对。现有在途/verified 依赖、其他对象隔离及 metadata-only permit 原边界仍生效。原 journal、NULL snapshot、attempt、旧 Receipt 和未确认历史不修改，不重发任何 Drive 写入。

实现采用带原精确函数体哈希和属性校验的前向迁移，仅把两个私有 current-registration validator 的空目录真值断言改为实际布尔事实校验；函数 OID、Owner、ACL、SECURITY DEFINER、volatility 和 search_path 必须保持。其他旧证明验证器、计划、提交事务及 I11 permit 不改。

本节尚为候选：真实 PostgreSQL/Worker 场景须覆盖 existing directory 与真实 legacy NULL create，active/trashed 物理子项不变且无子 Artifact，双观察变化与伪造事实拒绝，原有效 typed proof 优先、Receipt 失败回滚、并发及其他隔离不变。源码/CI、合并、迁移、同批部署、数据库先于页面及独立审核全部通过后才接受。目标自身的 trashed 状态、目录移动和非 job I12 仍未由本节交付。

## 26. 目录自身的当前回收站状态（e91 有限源码候选）

原 typed proof 仍先尝试正常结算。只有原 I9、完整 attempt/Receipt、关闭版本及终止窗口均合格时，当前程序才可独立登记一个 ordinary 目录自身的当前状态。原登记状态由锁定的 Artifact 推导为 `registered_state`；两次实际 GET 的 `trashed` 与 `explicitlyTrashed` 必须都是严格布尔且相等，推导 `current_state` 为 active 或 trashed。父链始终 active；不放宽原 `path_current_v1`，而是对目标身份、原状态、版本与 Decision 单独 CAS。root、track、撤销的目标和 active/trashed 登记后代不纳入本有限出口。

当前目标在回收站时不拥有 active 名称槽；同名的其他 active 对象不被接管、登记或覆盖。该目标不枚举子项，`empty` 必须为 null，不能从无法列举推导空目录。active 目标继续真实列举并保留实际布尔 child-presence 事实。两种状态均保留当前 full scope、完整 owner-private ACL、明确旧摘要匹配、连续父链、30 秒双读和真实 wall-clock 复检；缺失权限证据不由程序填 true。

Google 的 `files.permissions` 仅在请求者可分享时才保证完整。回收站目标的 canShare 不为 true 时，使用真实 GET `files/{id}/permissions` 完整分页（包含 published view），不制造分享能力、不复用不完整字段。列表缺失、重复权限/分页标记、权限不唯一、额外 grantee 或分页未完成均拒绝本次资格并由既有程序退避重读。仅支持当前账号拥有的 My Drive 私有对象；读权限列表不授予分享、删除或恢复权限。依据：[File 元数据](https://developers.google.com/workspace/drive/api/reference/rest/v3/files)、[permissions.list](https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions/list)。

目标状态使用独立 private permit，绑定当前事务、pending 独立 Receipt、原 intent、Owner/profile、目标 ID 与完整 before/after hash，允许的差量仅为 state 和既有元数据资格白名单。父链只用原 metadata permit，原 permit 逐字段禁止状态变化的规则保持。采用既有 `storage-object:` 物理锁域的有界 try-lock，在锁下拒绝跨 Owner/profile 的 live 物理别名、其他在途或 verified 依赖以及其他隔离的 object/slot/subtree/unknown scope；已知无关兄弟目录的隔离保留且不扩大到全根。

新结果携带 `current_artifact_state`。原 mutation 保持 conflict、原 request/snapshot/attempt/Receipt 不动，新资格、全部受写行、版本/ref、Event、独立 Receipt 和本 intent 的隔离出口同事务提交，失败全部回滚。页面必须区分“目录在回收站，原作业已自动处理”与 active 恢复使用。它不执行 delete/untrash、不自动授予 destructive/canUntrash，也不绕过以后真正 restore 的原 P5、空目录和名称冲突准入。

先验收真实 PostgreSQL 的四状态矩阵、拒绝/原子回滚、真实连接锁竞争、别名与登记后代，再测 GET-only Worker、HTTP 与页面。源码/CI、正常合并、迁移与同批发布、生产数据库、页面、独立审核和持久归档通过后才接受；本节不宣告目录移动、非 job I12 或暂停事项完成。

