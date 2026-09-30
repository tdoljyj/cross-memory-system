# Clued Storage 正常使用合同 v0.1

## 0. 文档边界与实施门槛

- **类型**：与实现、迁移和验收直接绑定的工程合同。它不是上线证明，也不是任何阶段的实施授权。
- **状态**：**CANDIDATE（r4.1）**。r3 独立审查（FAILED：2 个 MAJOR、12 个 MINOR、1 个 NIT）已按 §0.2 处理；r4 复审 **PASS**（0 BLOCKER / 0 MAJOR），其 5 个 MINOR 按 §8.1.9 并入；Owner 决定不变（Decision `7dbb4c09-c425-4e62-8aca-479dff482acc`，§11）。
- **源码基线**：`25cfe793`（`main`，PR #415 合并后）。P3 A/B 与 **P4 `replace` 均已合并并部署生产**（迁移 `20260930120000_storage_overwrite_v1.sql` 已应用）。本文件所有行号按该提交核对。
- **延续 Task**：`2aa57e7c-9960-45bc-a6f2-ba0c7d74ec9a`；不新建 Program。
- **Owner 决定**：
  - Decision `dc594258`（2026-09-30）：接入 Google Drive 必须让 Owner 和以后所有用户都能正常使用。要点：直接申请 `drive.readonly`（与 `drive.file`、`drive.metadata.readonly` 并存），根内所有文件可读，服务端仍限于资料根；常见格式可用、Agent 可上传二进制、额度按每小时数百 MiB、页面一个开关开启；先于 P5 / P6 / P7，P4 独立完成。
  - Decision `7dbb4c09`（2026-09-30，取代 `7de051b5`）：Q1–Q3、Q5、Q7–Q10 不变；**Q4、Q11 改判**；新增 **N0 自助接入**与**照片处理**决定。全文见 §11。

### 0.1 修订关系

本文件是 `StorageFullCapability.v0.1.md`（下称 **SFC**）的修订件。被修订条款在对应阶段上线时生效；上线前原条款继续有效。

| SFC 原条款 | 修订后 | 生效期 |
| --- | --- | --- |
| §4 D1、§9 D1 先实测 Picker | **作废**，改为直接申请 `drive.readonly`（§2）；Picker 只用于 N0 选择已有目录（§8.1） | N0 / N1 |
| §3.1 不做二进制上传 | `create` 支持二进制（§6） | N3 |
| §5.4 只支持文本，256 KiB / 8 MiB | 格式矩阵（§4）；额度（§7） | N1 / N2 |
| §5.3 `search` 只按名称和类型 | 增加 `fullText contains`（§5.2） | N1 |
| §8 P2、P7 scope 待定 | P2 已有文件正文由 N1 覆盖；P7 写入 scope 另行决定（§1.2） | N1 |
| §8 分期顺序 | N0–N4 全部完成前，不开工 P5 / P6 / P7 | 即时 |

**实施门槛**：沿用 SFC §8：每期 PR + CI + 独立审查、Owner 批准合并、Owner 批准生产迁移与发布、Owner 批准开关与真实验收，分别进行，任何一期不自动进入下一期。

### 0.2 r3 审查处理索引

r2 审查（B1、M1–M9、m1–m8）的处理索引见 r3（`162061a`）§0.2，结论仍然有效。下表为 r3 审查项；行号按 `25cfe793`，迁移前缀 `apps/clued-cloud/supabase/migrations/`。

| 编号 | 核对位置 | 处理 |
| --- | --- | --- |
| MAJOR-1 | 策略行须 `source_decision_id`（FK `clued_memories`）、`decision_version`、非空 `scope_digest`（`20260928051323_…policy_foundation_v2.sql:65-68`）；`storage_policy_scope_digest_v2`（同文件 `:125-148`）在 profile 无 `cloud_runtime`（`clued.storage-cloud-runtime/1`，1–32 个 track，且每个都有 active 目录 artifact）时返回 NULL；profile 须 `project_id`、`source_decision_id`、`root_folder_id`、`root_parent_id`（`20260926134500_…artifact_authority_v1.sql:6-14`），后续变更复查 `resource_center_decision_current_v1`（`:302-311`）；`storage_oauth_attempts_v1.connection_id not null`（`20260927075249_…:11`）；各包装器经 connection → profile 取根（`20260927083521_…:217-222`、`20260927145426_…:66-71`）；OAuth descriptor 在 start 前须有根 ID（`storage-google-oauth.ts:26-33`）；读 agent 拒绝 60 秒内过期的 token（`storage-read-agent.ts:218-220`）；默认刷新资格（`20260927145426_…:77-82`）；客户端登记只能是 `reviewed_snapshot`（`20260928051323_…:25`、`20260928060125_…:1-8`） | §8.1 重写：完整对象图、顺序、Drive 目录的幂等 effect 与孤儿记录、默认刷新委托、客户端资格 |
| MAJOR-2 | Agent 拿不到 `clued_bnd_` bearer（`continuity.ts:1528-1529` 由 Worker 从请求头取得） | §6.2：新增 MCP 工具 `clued_storage_upload_begin`，返回单次使用的签名 PUT URL；端点只认签名 |
| m-a | Picker token 范围 | §8.1 第 3 步 |
| m-b | 选中根的形态 | §8.1 第 3 步 |
| m-c | `provider_scope_profile` | §6.1；§8.1 第 6 步 |
| m-d | 暂存后宏检测 | §6.3 |
| m-e | 上传预占时点 | §6.2、§7.2 |
| m-f | 从 `mutation.content` 推导 size / sha256 的现行定义：`20260928072813_…account_cloud_v2.sql:130-137`（`storage_job_provider_attempt_v2`）；`20260928074834_…verified_settlement_v2.sql:254-255` 与其重定义 `20260929200000_…directory_sharing_v1.sql:685-686`（`storage_verified_result_v2`）；`20260930100000_…modify_execution_v1.sql:182-183, 228-229` 与 `20260930120000_storage_overwrite_v1.sql:466-515` 对两者的源码补丁；`kernel/host/resource-center-google-drive-postcondition.mjs:52-55` | §6.2 迁移项 |
| m-g | pdf.js Range 分块与 `SUBREQUEST_BUDGET = 50`（`storage-read-agent.ts:21`） | §4.1 PDF 段 |
| m-h | `resource_link` 计费与下载复核 | §4.4 |
| m-i | 现有 search 是 Worker 侧目录遍历（`storage-read-agent.ts:410-446`，`storage-google-metadata-batch.ts:159`） | §5.2 |
| m-j | 083521 的包装器现为 `clued_private.storage_oauth_recovery_v1`（`20260927145426_…:56-57`），外层依次为 `clued_private.storage_oauth_connection_consent_v1`（`20260927211632_…:143-144`）与 `public.clued_storage_oauth_v1`（`20260927211632_…:146-168`） | §2.4 第 3 项 |
| m-k | refresh token 累积 | §2.4 第 8 项 |
| m-l | 暂存 AEAD 密钥与 nonce | §6.2 |
| NIT | 5 MiB 与部分客户端 5 MB | §10 N2 验收 |

## 1. 目标与非目标

### 1.1 目标

1. 新用户能在网页上自助完成连接（N0），无需 Host 同步。
2. 开启“正常使用”后，Agent 能读取资料根内**任意**文件，并能按内容全文搜索。
3. 常见格式在主流 MCP 客户端上真正可用：优先给文本或图片，原始字节只作为短时下载链接（§4）。
4. Agent 能新建二进制文件，写后按 sha256 核验。
5. 额度足够日常整理资料使用，Owner 可以调整。

### 1.2 非目标

- **不申请 `drive` 或 `drive.metadata`。** `drive.readonly` 只能读。用户手动上传的文件（非 Clued 创建）在 P7 写入 scope 决定之前**不能改名、移动或进回收站**；页面与工具描述须如实说明。
- 不改变根范围模型：一个登记根，按 provider ID 父链判定（SFC §5.2）。
- 不做 OCR、音视频转码或抽帧。扫描版 PDF 无文字层时如实返回。
- 不做二进制 `replace`（P4 保持 UTF-8 文本）。
- 不改本机 Host 试点凭据 `kernel/host/resource-center-google-drive-credential.mjs:2-3`。
- 不改变共享 / ACL、永久删除、跨根操作的既有禁令。

## 2. Google scope 变更

### 2.1 现状（`25cfe793`）

- 连接流程要求授予集合**完全等于** `{drive.file, drive.metadata.readonly}`：`apps/clued-cloud/worker/storage-google-oauth.ts:4, 101-102, 135-136`；封存时写入常量（`:160`）。
- 同样的“完全相等”：`storage-google-refresh.ts:4, 6, 56, 77, 89`；`storage-cloud-executor.ts:12, 42`；`storage-cloud-recovery.ts:13, 80`；`storage-google-probe.ts:12, 83`；`storage-read-agent.ts:16, 218`；`kernel/host/resource-center-cloud-executor.mjs:18, 141`。
- 包含关系（已容忍超集）：`kernel/host/resource-center-google-drive-create-effect.mjs:28-31`、`…-modify-effect.mjs:62-65`、P4 新增的 `…-replace-effect.mjs:66-69`、`…-metadata.mjs:3-8`。
- 连接时要求根对象 `isAppAuthorized === true` 与 `canAddChildren`（`storage-google-oauth.ts:145-152`）。保留。

### 2.2 精确允许集合

| profile | 集合 | 能力 |
| --- | --- | --- |
| `legacy` | `drive.file` + `drive.metadata.readonly` | 现有能力；正文只限 Clued 自建文件 |
| `normal` | 上述 + `drive.readonly` | 另可读根内任意文件正文、全文搜索 |

1. 单一模块 `apps/clued-cloud/worker/storage-google-scopes.ts` 与 kernel 镜像 `kernel/host/resource-center-google-scopes.mjs` 导出 `scopeProfile(value): "legacy" | "normal" | null`（去重排序后逐一比较；含 `drive`、`drive.metadata` 或其他 scope 返回 `null`）及各 profile 的请求集合。
2. §2.1 所列“完全相等”处改为 `scopeProfile(x) !== null`；封存写入**实际授予**的规范化集合。
3. 读非 Clued 文件正文、全文搜索额外要求 `scopeProfile === "normal"`。写路径两种 profile 都接受。
4. **刷新不得改变 profile**：刷新响应带 `scope` 时 profile 须等于封存值，否则按失败处理、要求重新同意。
5. **CI 防漂移**：kernel 四处包含关系校验（`create-effect.mjs:30-31`、`modify-effect.mjs:64-65`、`replace-effect.mjs:68-69`、`metadata.mjs:3-8` 的 `NAMESPACE_READ_SCOPES`）改为从 kernel 镜像模块导入。新测试断言 scope URL 字面量只出现在两个模块、测试夹具与本机试点凭据文件中；Worker 与 kernel 模块导出值逐项相等。
6. 连接行新增 `provider_scope_profile text not null default 'legacy' check (… in ('legacy','normal'))`，由 `complete` 事务按 Worker 计算值写入，随 `credential_version` CAS 更新。读判定器在 admission 中返回；Worker 开启凭据后与封存集合交叉核对，不一致返回 `storage_read_unavailable`。
7. **恢复 OAuth**（`storage-google-recovery-oauth.ts` 复用 `createStorageGoogleOAuth`，`:16, 33`）：`describe` 返回封存 profile，恢复只请求该 profile 的集合；`complete` 授予 profile 不等于封存 profile 时失败，凭据不变。恢复不得升级或降级（N1 测试）。

### 2.3 同意流程与部分授权

- 请求参数不变：`access_type=offline`、`prompt=consent`、`include_granted_scopes=false`、S256 PKCE；scope 按本次意图取集合。
- 用户可在同意页取消勾选。`complete` 按实际授予：等于 `normal` → `normal`；等于 `legacy` → `legacy`，页面提示“未授予‘查看云端硬盘中的所有文件’，正常使用未开启”；其他 → 现有 `scope_mismatch`。

### 2.4 已连接用户的重新同意

1. 完成前连接保持 `legacy`，一切照旧；读非 Clued 文件得到 `scope_upgrade_required`（指向页面开关）。不强制迁移，不停服。
2. 走“对同一连接重新授权”（`createStorageGoogleOAuth.start(connection_id, …)`）。新凭据在 `complete` 事务中以 `credential_version` +1 原子替换；任何一步失败，旧凭据与连接原样保留（N1 必测）。
3. **忙碌判定与刷新委托延续**（M2）：
   - 忙碌判定直接用 083521 包装器已调用的 `storage_root_quiet_v1`（`…/20260927083521_…account_refresh_v1.sql:32-39, 225`），不另写并行检查。`prepare` 时先调用一次同一函数以尽早提示；`storage_root_has_unresolved_mutation` 在页面映射为 `storage_root_busy`“稍后再试”。
   - 包装链现状（m-j）：`public.clued_storage_oauth_v1` = 211632 分派器（`…/20260927211632_…:146-168`）→ `clued_private.storage_oauth_connection_consent_v1`（145426 包装器，默认刷新，`…/20260927145426_…:59-130`，由 `211632:143-144` 改名）→ `clued_private.storage_oauth_recovery_v1`（083521 包装器，`:234-236` 关闭根下全部委托，由 `145426:56-57` 改名）→ `clued_private.clued_storage_oauth_v1`（075249 原函数）。
   - 不复用 `default_refresh_consent`（只对 `awaiting_provider` 且 `credential_version=0` 有效，`145426:77-82`）。**延续规则放在新的最外层包装器**：N0 迁移（先于 N1）把 211632 分派器改名为 `clued_private.storage_oauth_dispatch_v1`，新建 `public.clued_storage_oauth_v1`，先只承担 `onboard` 分派（§8.1 第 4 步）；N1 迁移以 `create or replace` 在同一最外层函数中加入延续规则。延续规则只对 `purpose='connection'` 的 `complete` 起作用：调用内层之前锁定并快照该连接的委托行（`enabled`）与 `provider_subject`、`oauth_client_id`、根 ID；内层返回 `completed` 后，若快照 `enabled=true` 且三项与 prepare 快照（prepare 时由同一包装器写入 attempt 行）、与内层完成后的连接行都相同 → 把该连接的委托改回 `enabled=true`（`version` +1），写独立 Receipt `storage_refresh_delegation_carry` 与 Event；根下其他委托保持内层关闭的结果。任一条件不满足 → 不动（即与现在一样关闭）。`credential_recovery` 与 N0 `onboard` 目的不经过该规则。
   - 执行器按 `credential_version` 取凭据（`storage-cloud-executor.ts:33-36` 版本不符即拒绝）。实现 PR 须证明已排队但尚未 prepared 的作业在执行时读取当前 `credential_version`，不会因换凭据被误判失败；否则 prepare 同样返回 `storage_root_busy`。
4. **升级后不调用 Google revoke**（B1、Q11）。Google 的 revoke 很可能撤销整个“用户 × 客户端”授权，连同刚获得的新 token。改为：`complete` 事务用新信封覆盖 `storage_connections_v1.credential_envelope`（`…/20260927075249_…oauth_connector_v1.sql:109`），旧信封在数据库中不再有任何副本。
5. **无残留测试**（N1 必测）：升级后对 `clued_private` 与 `public` 全部 `jsonb` / `text` / `bytea` 列搜索旧信封密文与其 `m1_sha256` 摘要以外的任何片段，命中数 = 0。已知只存摘要的位置（目录探测 `…/20260927183650_…directory_probe_v1.sql:113`）按摘要处理；刷新 claim 只把信封交给 Worker、不落表（`…account_refresh_v1.sql:144-147`），测试同样覆盖 refresh / probe / recovery attempt 行、Receipt 与 Event 载荷。维护文档写明：被覆盖的行版本在 VACUUM 前仍在堆中，PITR 备份按保留期保留；旧 refresh token 在 Google 侧仍有效，但 Clued 不再持有可解密副本。
6. **revoke 只用于两处**：“撤回全部文件读取授权”（revoke 后以 `legacy` 集合重新同意）与“断开连接”。两处的确认文案必须写明：**“这会断开该 Google 账号在 Clued 中的所有连接，其他连接需要重新授权。”** 其他连接随后刷新得到 `invalid_grant`，按现有“无效凭据需重新同意”处理（`docs/maintenance/resource-center-account-connection.md:112-114`）。关闭“正常使用”开关本身不缩小 token scope，文案须说明。
7. **N1 前置核实**：实现者用真实 Google 账号验证：同一客户端先授予 A（legacy）、再授予 B（normal），revoke A 的 refresh token 后 B 是否失效；revoke B 后同账号其他连接是否失效。结果写入维护文档。结果与本节假设不同时只能收紧文案，不得恢复升级后 revoke。
8. **refresh token 累积**（m-k）：Google 对每个“Google 账号 × OAuth 客户端”保留的 refresh token 数有上限（当期文档为 100），超出时**静默作废最早签发的 token**，不通知。不 revoke 旧 token（第 4 项）意味着每次重新同意、恢复 OAuth、N0 接入都多占一个名额；换 token 成功但 `complete` 提交失败（`storage-google-oauth.ts:161-163` 的 `credential_commit_unconfirmed`）或 N0 中途失败留下的 token 是**孤儿**，同样占名额。要求：(a) 按 `(owner_id, provider_subject, oauth_client_id)` 计数：每次 `claim`（换 token 之前）计 1，保守地把可能的孤儿计入；(b) 页面在计数 ≥ 50 时提示，≥ 90 时拒绝新的重新同意并引导“撤回全部文件读取授权”（revoke 后计数清零）；(c) 某连接刷新得到 `invalid_grant` 而计数接近上限时，页面文案写明可能原因是名额被挤出；(d) N1 真实账号核实上限行为，写入维护文档。

### 2.5 Google 受限 scope 审核

- `drive.readonly` 与 `drive.metadata.readonly` 同属受限 scope。对外正式使用前须通过 OAuth 应用验证与安全评估（CASA，通常每年一次），以 Google 当期政策为准。
- 未验证前：Testing 状态只对名单内测试用户，refresh token 7 天过期；未验证 Production 有警告与用户数上限。
- **N1 开工即提交验证申请**（m7），并行推进，不等 N4。Owner 与测试用户可在 N1 后使用；N0 自助接入对名单外用户开放以验证通过为前置门槛（Q9）。

## 3. 服务端根范围：`drive.readonly` 下的强制

`drive.readonly` 让凭据能读整个 Drive。根范围完全由 Clued 服务端保证，沿用 SFC §5.2 并加强为结构性约束：

1. **判定不变**：`storage-read-agent.ts:228-276` 的 `inRoot`：每条父链须在 32 级内按 provider ID 到达登记根；多父任一在根外即拒绝；缺失或不可见视为根外；快捷方式不跟随；回收站对象不可读正文；共享盘视为根外。
2. **单一内容通道与 URL builder**：`admittedContent(fileId)` 只接受本次调用中已通过 `inRoot` 的 ID，是唯一能构造 `alt=media`、`/export`、Range 请求的函数；URL 固定 host `www.googleapis.com`，路径白名单 `/drive/v3/files/{id}`、`/drive/v3/files/{id}/export`。缩略图另设**专用 builder**（§4.2），只接受同一调用中对已判定 ID 取回的 `thumbnailLink`。调用方不能传入 URL。
3. **`text/1` 模式下的应用授权**（M4）：读取授权为 `text/1`（或连接为 `legacy`）时，即使 token 是 `normal`，Worker 在发出任何 media / export 请求前必须从元数据确认 `isAppAuthorized === true`；否则返回 `scope_upgrade_required`，media 请求数 = 0。不再依赖 Google 返回 403/404。
4. **读后复核**（m3）：取回字节后、返回前，用**新的空缓存**从对象重新完整遍历全部祖先链（不是只 GET `parents`），任一步不在根内或进回收站即丢弃字节，返回 `not_found_in_scope`。复核计入 `SUBREQUEST_BUDGET = 50`（`storage-read-agent.ts:21`）：发出内容请求前按首次遍历深度 + 1 预留，余额不足即不下载、返回 `storage_read_unavailable`。
5. **不暴露 provider URL**：`webContentLink`、`thumbnailLink`、`exportLinks`、resumable session URI 不进入工具响应、回执或日志。
6. **错误码不区分根外与不存在**：一律 `not_found_in_scope`。
7. **base64 分块**：`storage-read-agent.ts:120` 与 `storage-google-oauth.ts:15` 的 `btoa(String.fromCharCode(...bytes))` 对大数组会 `RangeError`。新增共享 helper，按 ≤ 32 KiB 分块编码；所有二进制交付与上传解码使用它（N1）。

**负向测试（N1 必过，合成 provider 中令 token 对根外文件“可读”）**：

| # | 场景 | 期望 |
| --- | --- | --- |
| R1 | 根外 `.txt` | `not_found_in_scope`；media 请求数 = 0 |
| R2 | 多父对象，一条父链在根外 | 同上 |
| R3 | 根内快捷方式指向根外 | `shortcut_not_followed`；对目标请求数 = 0 |
| R4 | 共享盘文件 ID | `not_found_in_scope` |
| R5 | 父链 > 32 级 / 成环 | `not_found_in_scope` |
| R6 | 首次遍历后、复核前，**祖先目录**被移出根 | `not_found_in_scope`；字节不返回 |
| R7 | zip 条目名 `../x`、绝对路径 | 只作名称返回，不影响 provider 请求 |
| R8 | 内容通道收到未判定 ID | 抛错；无 fetch |
| R9 | `legacy` 连接读非 Clued 文件 | `scope_upgrade_required` |
| R10 | `normal` token + `text/1` 授权 + 非 Clued 文件 | `scope_upgrade_required`；media / export 请求数 = 0 |
| R11 | 复核预算不足 | `storage_read_unavailable`；media 请求数 = 0 |

### 3.1 写路径的孤岛规则只计应用已授权条目

**原因（2026-09-30，作业 `b9d6db9d`）。** 两种凭据档位都能列出整个 Drive 的元数据：`legacy` 一直持有 `drive.metadata.readonly`（`kernel/host/resource-center-google-scopes.mjs`），`normal` 另加 `drive.readonly`。元数据 API 的不存在 / 唯一性证明正依赖这一完整视图（`resource-center-google-drive-metadata.mjs` 的 `NAMESPACE_READ_SCOPES`）。云端执行器的边界扫描从 `root_parent_id`（My Drive）起枚举，`detectResourceCenterBoundaryViolations`（`kernel/policy/resource-center-mutation-policy.mjs`）的孤岛规则把资料根之外任何名称含 `clued` 的条目判为 `UNAUTHORIZED_WORKSPACE_MUTATION`。Owner 自己的 `Clued_*` 文档、文件夹，以及其他工具在 My Drive 中的同名资料因此被当作孤岛，所有写作业在预留前被拒绝。这与凭据档位无关：Drive 中一旦存在这类 Owner 资料，两种档位同样受影响。

**修复（Clued Decision `fd94bd2f-ff3d-43ad-9520-5c8d8cd5ee84`）。** 只有孤岛规则收窄，其余一律不变。

1. **孤岛规则只计 `isAppAuthorized === true` 的条目。** 边界扫描（`kernel/host/resource-center-google-drive-boundary.mjs`，逐目录与批量两种模式）的列举在 `fields` 中带上 `isAppAuthorized`：逐目录模式由执行器以 `listFolder(id, {app_authorized: true})` 请求，批量传输（`storage-google-metadata-batch.ts`）的 `fields` 本来就含该字段。扫描把每个观察到的条目连同 `is_app_authorized` 交给 `detectResourceCenterBoundaryViolations`；资料根之外、名称含 `clued` 的条目只有在 Clued 应用创建或打开过（`isAppAuthorized === true`）时才构成 `UNAUTHORIZED_WORKSPACE_MUTATION`。只有显式的 `is_app_authorized: false` 才豁免；字段缺失或取其他值按应用已授权处理，仍被标记（失败关闭）。显式 `artifact_role: "clued_resource"` 不属于孤岛规则，不因该字段豁免。
2. **列举不过滤。** 扫描、provider 身份解析、创建 / 改名移动 / 覆盖的后置核验与唯一性检查、恢复结算看到的仍是完整列举，Owner 与其他工具的条目照常参与：同名 / `PATH_AMBIGUOUS`、快捷方式、根冒充 / `ROOT_CHANGED`、深度与条目上限（10000）以及身份解析和后置核验的不存在 / 唯一性证明全部保持原样。目标目录中存在 Owner 的同名文件时，结果与该文件由 Clued 创建时完全相同（失败关闭）。
3. **形状比较忽略该字段。** 列举条目带 `isAppAuthorized`，而逐目录模式的 `getFile` 不带；扫描在比较目录与根的身份 / 版本时只去掉这一个字段，其余字段逐一比较。
4. **诊断。** 执行器每个拒绝以 `console.warn({event:"storage_cloud_denied",error_code})` 记录固定码；描述符 / 形状检查（`CLOUD_DESCRIPTOR_INVALID`、`CLOUD_PROFILE_INVALID`、`CLOUD_MUTATION_SHAPE_INVALID`、`CLOUD_METADATA_BATCH_INVALID`）、`DRIVE_BOUNDARY_*` 扫描拒绝、凭据与 Drive 传输失败导致的 `unavailable`（作业报告为 `attention_required`）以 `storage_cloud_unavailable` 记录固定码（`CLOUD_*`、`DRIVE_*`、`PROVIDER_*`、`STORAGE_*`，其余为 `UNSPECIFIED`）。日志不含作业 ID、路径、扫描发现或 provider 文本。
5. **原因入库（`20260930230000_storage_dispatch_reason_v1`）。** 账户策略模式下，预留前的 `report` 把同一固定码写入作业 `dispatch_outcome`（dispatch_outcome 事件的 `change_summary` 只带 `code` 与 `finding_count`，不带路径，因为该事件会进入 Canonical 导出）：`{status, reason:{code, findings?}}`，`code` 须匹配 `^[A-Z][A-Z0-9_]{2,63}$`；`findings` 仅限 `denied`，1–10 条 `{path(1–1000 字符), reason(^[a-z][a-z0-9_]{2,63}$)}`，只存于 Owner 私有行，不进日志。`clued_storage_inspect` 只返回 `reason_code`。不带 `reason` 的旧形状仍被接受；服务端拒收时 Worker 退回 `{status}`。

**测试（必过）**：合成 Drive 按现实建模，`legacy` 与 `normal` 凭据都列出 Owner 条目（`isAppAuthorized: false`）。资料根之外的 Owner `Clued_*` 文档 / 文件夹：扫描为空，创建照常提交（逐目录与批量两种模式，两种凭据；改名 / 覆盖的 DB 夹具同样放入该 Owner 文档）。应用授权的 Clued 命名意外条目仍被标记；字段缺失仍被标记。Owner 的重名、快捷方式、根冒充、深度与条目上限仍按原码失败；目标目录中的 Owner 同名文件与 Clued 同名文件结果相同。

## 4. 读取格式矩阵

判定顺序：先按 Drive `mimeType`；通用类型再按扩展名与魔数；魔数与声明不符按魔数处理，响应带 `declared_mime_type`。所有交付带 `untrusted_content: true`。

### 4.1 矩阵

| 类型 | 默认行为（`as=auto`） | 单次上限 | 期 |
| --- | --- | --- | --- |
| `text/*`、JSON、XML、YAML、JS、SVG（按文本） | 文本按字节范围内联（现有逻辑，`storage-read-agent.ts:362-376`） | 256 KiB | N1 |
| Google 文档 | export `text/markdown`，回退 `text/plain` | 256 KiB / 段；export 10 MB | N1 |
| Google 表格 | export xlsx → 内存模式 zip 读取（§4.3）→ 每表 CSV 段 | 同上 | N1 |
| docx | 段落文本 | 256 KiB / 段 | N1 |
| xlsx / pptx | 共享字符串 + 单元格；各页文字 | 同上 | N2 |
| Google 幻灯片 | export `text/plain` | 同上 | N2 |
| Google 绘图 | export `image/png`，按图片 | 同图片 | N2 |
| 其他 Google 原生 | `format_unsupported` + 元数据 | — | N1 |
| PDF | **服务端文字提取**，`pages` 指定页范围；无文字层返回 `text_layer_absent: true` | 256 KiB 文本、≤ 20 页 / 次 | N2 |
| odt / ods / odp | 同一 zip + SAX 路径取 `content.xml` 文本；ods 每表 CSV | 256 KiB / 段 | N2 |
| 旧版 doc / xls / ppt | 只有 `as=raw`（下载链接） | 见 §4.4 | N2 |
| png / jpeg | MCP image（原图） | 5 MiB 且长边 ≤ 8000 px | N1 |
| gif / webp | MCP image | 同上 | N2 |
| heic / tiff / bmp，或 > 5 MiB 的图片 | 缩略图 → Cloudflare Images（§4.2），否则 `image_too_large` | 输出 ≤ 5 MiB | N2 |
| zip | `as=listing` / `entry=<路径>`（条目再按本矩阵判定；嵌套 zip 不递归） | §4.3 | N2 |
| rar、7z、tar、gz | `format_unsupported` + 元数据 | — | N1 |
| `video/*` | 元数据：`videoMediaMetadata`、size、校验和、modifiedTime；处理中 `processing: true` | 无字节 | N2 |
| `audio/*` | size、校验和、modifiedTime | 无字节 | N2 |
| 其他二进制 | `format_unsupported` + 元数据；`as=raw` 允许 | §4.4 | N2 |

**PDF 提取**：在 Worker 内用 pdf.js 的无 DOM 构建（如 `unpdf`）。≤ 32 MiB 整份经 `admittedContent` 下载；更大文件用 pdf.js 按需 Range 加载，每次调用 provider 字节仍 ≤ 32 MiB，超出返回 `binary_too_large` 并提示缩小页范围。Range 模式（m-g）：`rangeChunkSize` = 1 MiB（pdf.js 默认 64 KiB，按默认 32 MiB 需约 512 次请求）、`disableAutoFetch: true`、`disableStream: true`；内容请求另设预算 `CONTENT_REQUEST_BUDGET = 40`，与元数据 / 祖先遍历用的 `SUBREQUEST_BUDGET = 50`（`storage-read-agent.ts:21`）分开计数，两者之和不得超过 Worker 套餐的每次调用子请求上限（N2 PR 写明所用套餐与上限）；任一预算耗尽返回 `storage_read_unavailable`，不返回部分页。响应带 `page_count`、`pages`、`next_pages`。CPU 超时返回 `storage_read_unavailable`，不返回部分结果；N2 PR 实测 128 MB 内存与 CPU 上限下的最大可处理规模并写入维护文档。

### 4.2 图片降采样（照片决定）

1. **Drive 缩略图**（首选）：同一调用中对已判定 ID `files.get(fields=thumbnailLink,…)`，交给专用 `thumbnailFetch(link)`：
   - 只接受 `https`、无 userinfo / 端口，host 完全匹配常量正则（`*.googleusercontent.com` 的精确模式，如 `^lh[0-9]+\.googleusercontent\.com$`，N2 前实测后固定）；
   - 仅把尺寸参数改写为长边 2048；bearer token **只**发往该 host；`redirect: "manual"`，任何 3xx 即失败；
   - 响应须为 png / jpeg 魔数且 ≤ 5 MiB。链接不进入响应、回执、日志。
2. **Cloudflare Images binding**（缩略图不可用或 HEIC 无缩略图时）：原图经 `admittedContent` 流式送入（≤ 32 MiB），转换为 jpeg、长边 2048。按转换次数计费，有免费额度（以 Cloudflare 当期定价为准）；读回执记 `image_transform: true`，每 owner 每月转换次数上限默认不超出免费额度，N4 可调。
3. 都不可用 → `image_too_large` / `format_unsupported`，附元数据。响应带 `downscaled: {width, height, via: "thumbnail"|"images"}`。

### 4.3 zip 与 XML 限制（防 zip bomb，任一超出返回 `archive_limit_exceeded`）

- **Range 模式**（Drive 二进制文件）：先读末尾 ≤ 64 KiB 找 EOCD / Zip64 EOCD，再按偏移读中央目录。
- **内存模式**（无 Range 的 export，如表格 → xlsx）：只在 export ≤ 10 MB（现 `EXPORT_MAX`，`storage-read-agent.ts:24`）时启用，整份读入后解析。
- 绝对上限（不用压缩比）：中央目录 ≤ 4 MiB；条目数 ≤ 10 000，`as=listing` 每页 500 条（游标沿用 SFC §5.3 封签）；单条目解压后 ≤ 32 MiB；单次调用累计解压 ≤ 32 MiB；流式计数实际解压字节，超限立即中止。
- 只支持 stored（0）与 deflate（8），其他 `entry_method_unsupported`；加密条目 `entry_encrypted`。
- 条目名只作不可信字符串：规范化 `/`，含 `..`、绝对路径、控制字符的标 `unsafe_name: true`。
- XML（OOXML、ODF）用**流式 SAX 解析器**：遇到任何 `<!DOCTYPE` 即拒绝（`document_invalid`），不做实体展开；单个部件 ≤ 16 MiB；输出文本 ≤ 256 KiB / 段。

### 4.4 原始字节交付（Q4）

- 不内联长 base64，不交付 provider URL。`as=raw`（及无文本路径的格式）返回 MCP `resource_link`：`https://<Clued 主机>/storage/download/<token>`，带 `name`、`mimeType`、`size`。
- token 由 Clued HMAC 签名，绑定 `owner_id`、`connection_id`、Binding、`provider_file_id`、`head_revision_id`（或 sha256）、`entry?`；有效期 ≤ 5 分钟、单次使用（数据库记 `jti`）。
- 下载端点重新执行 admission（读取授权仍为 `normal/1`、`provider_scope_profile = normal`、连接与 profile、按客户端 deny），**不再预占额度**，并先完整遍历祖先链。
- **缓冲后复核**（m-h，二选一取此项）：端点经 `admittedContent` 把原始字节读入内存（≤ 32 MiB，超出 `binary_too_large`），核对 `head_revision_id` 或 sha256 与 token 一致，再按 §3 第 4 项用新的空缓存重走祖先链，通过后才开始向客户端发送。这样所有交付路径都遵守同一条“字节离开 Worker 之前已完成读后复核”；代价是 32 MiB 常驻内存（128 MB 限额内），N2 PR 实测并发两个下载时的内存余量。不采用“只在发送前检查、边读边转发”。
- **计费**（m-h）：签发链接的那次 `clued_storage_read` admission 负责预占：交付字节与 provider 字节都按文件 size（export 无 size 时按 10 MB）预占，预占行以 token 的 `jti` 为键。端点结算同一行为实际字节，不重复计费；链接过期未用时，清理器把该行结算为 0（释放）；端点失败时按已从 provider 读取的字节结算 provider 维度、交付维度结算为 0。
- ≤ 1 MiB 的 raw 可改为内联 embedded resource（`blob`）；图片仍用 MCP image。

**Worker 资源**：单次调用 provider 下载 ≤ 32 MiB（含 export、zip 条目、Office 部件、PDF、原图）。流式读取、超限即取消（沿用 `capped`，`storage-read-agent.ts:313-326`）。

### 4.5 N1b 实施状态（Worker / kernel + 读额度迁移 `20260930200000`）

- **已实现**（仅 `normal` 凭据 + `normal/1`；否则与 N1a 相同）：docx / xlsx / pptx 与 Google 表格（export xlsx）→ 抽取文本，字节范围作用于抽取后的 UTF-8 文本（xlsx 每表 `# Sheet: <名>` + CSV，pptx 每页 `# Slide <n>`），单次抽取 ≤ 8 MiB 文本；≤ 10 MiB 整份下载，更大文件用 §4.3 Range 模式（256 KiB 预读块，计入同一 `SUBREQUEST_BUDGET = 50`，provider 字节 ≤ 32 MiB）；Google 幻灯片 export `text/plain`；png / jpeg / gif / webp ≤ 5 MiB 且长边 ≤ 8000 px → MCP image（`structuredContent` 不含 base64）；其余格式 `delivered_as: "none"` + `reason`（`format_unsupported` / `image_too_large`）+ 固定 `hint` + 元数据，不发正文请求。新增固定错误码 `document_invalid`、`archive_limit_exceeded`、`binary_too_large`、`request_limit_exceeded`（Range 模式用尽 50 次子请求，提示缩小 `offset + length`）。
- **内存（128 MB isolate）**：Range 模式只缓存 256 KiB 预读块（LRU 至多 4 块；大于一块的读取不缓存），中央目录解析完即清空缓存；xlsx 按行流式输出，文本预算用尽即停止 SAX 解析；只缓冲乱序行，至多 65 536 个单元格（超出 `archive_limit_exceeded`），已输出行的迟到单元格为 `document_invalid`（ECMA-376 要求行号递增；Excel 会把这类文件判为损坏并修复。是否报错取决于读到哪里：前段读取可能成功，后段才报 `document_invalid`。已知限制，失败即拒绝、不静默错位）。读取结算：`finalize` 的 `byte_count` 不得超过该回执的预留（默认 256 KiB，`reserve` 可扩到 ≤ 5 MiB），超出为 `storage_read_receipt_conflict`；`reserve` 只接受未撤销的 Binding。表头中表名的 CR/LF 替换为空格；pptx 表头与段名一致（`# Slide <n>`，n 为 `sldIdLst` 序号）；关系目标按 URI 百分号解码。
- **分块一致性**：offset ≥ 8 MiB 且全文已抽完且更短 → 空内容 + `eof: true`；否则 `archive_limit_exceeded`。分块调用各自独立，调用方比较 `head_revision_id`（Google 文档 / 表格 / 幻灯片比较 `modified_time`）判断文件是否变化。
- **读额度（§7.2，迁移 `20260930200000_storage_read_budget_n4.sql`）**：每 Binding 每滚动小时 256 MiB 交付字节（Owner 决定：读取 256 MiB / 小时）。admission 仍预占 256 KiB；图片在元数据分类之后、任何正文请求之前，对**同一**读回执调用 `reserve`，把预占扩到文件大小（≤ 5 MiB），与 admission 共用同一 Binding advisory 锁并计入全部在途预占，超出即 `budget_exhausted` 且不发正文请求；结算仍按实际交付字节，释放未用部分。文本 / Office（≤ 256 KiB）与 legacy / `text/1` 不调用 `reserve`。上线顺序：先把 N3 迁移 `20260930180000` 与本迁移应用到生产，再发布含 N1b 的 Worker。
- **PDF 文字提取（Q4，`worker/storage-read-pdf.ts`，仅 `normal` + `normal/1`；无迁移、无开关）**：
  - **实测**（`pdfjs-dist` 6.3.289 legacy 构建，Apache-2.0；本地 workerd `wrangler dev` 与 Node 22；合成夹具）：`wrangler deploy --dry-run` 生产 Worker 由 3 869.95 KiB / gzip 1 560.68 KiB 增至 6 372.40 KiB / gzip 2 595.53 KiB（+1 035 KiB gzip：pdf.js 主模块 477 KiB + worker 1 210 KiB + CMap 811 KiB，均为首次读 PDF 才加载的独立 chunk），Workers Paid 上限 10 MiB gzip，余量约 7.4 MiB。每页 CPU：文字页预热后 3–30 ms；每次调用首页 40–100 ms（JIT 预热、CJK CMap 解析约 80 ms）；整份未子集化的 6 MB CJK 字体所在页 200–250 ms（字体解析）。20 页英文 ≈ 220 ms/次（含模块加载）；18 MiB、60 页含大图的 PDF 读 20 页 ≈ 80 ms（`getTextContent` 不解码图片）。内存：Node 实测堆峰值 18–35 MB，外加文件本身（下载进一个按 Drive `size` 预分配的缓冲区，不做分块再拷贝）；20 MiB 文件合计约 40–55 MB，低于 128 MB。`unpdf`（MIT，打包 pdf.js 6.1.200 的 serverless 构建）体积相当（约 565 KiB gzip），未采用：版本滞后于上游且多一层维护者；pdfjs-dist 在 `nodejs_compat` 下直接可用。pdf.js 6 已无 eval 路径。
  - **CJK**：有 ToUnicode 的嵌入子集字体（Word / WPS / pdf-lib 常见输出）与未嵌入字体 + 预定义 CMap（UniGB-UCS2-H 等，iText / reportlab 常见）均正确；后者需要 CMap 数据，Worker 内置 `pdfjs-dist/cmaps` 中除 UTF-8 / UTF-32 / JIS X 0213 变体外的 141 个 bcmap（`worker/generated/pdf-cmaps.ts`，由 `scripts/generate-pdf-cmaps.mjs` 生成，测试核对与所钉版本一致；Adobe BSD-3 许可随文件保留）。缺少 ToUnicode 时 pdf.js 只能把字形码当码点输出：子集字体变成控制字符，整字体变成跨泰米尔 / 僧伽罗 / IPA 等无关文字的乱码。检测（`looksGarbled`，逐页）：非空白字符中控制符 / 私用区 / U+FFFD / 非字符 > 10%，或常见文字族之外的 128 码位块 ≥ 4 个且占比 ≥ 20%。命中页正文省略，结果带 `text_unreliable: {pages}` 与固定 hint，不返回乱码；需要的 CMap 未内置时带 `cmap_missing: true`。启发式：看似合理的错误汉字仍可能漏检（已知限制）。
  - **参数（取代 §5.1 `pages` 字符串）**：`page_start`（≥ 1，默认 1）与 `page_count`（1–20，默认 20）选页，`offset` / `length` 作用于所选页的抽取文本（每页以 `# Page N` 行开头，与 pptx 的 `# Slide N` 一致），单次 ≤ 256 KiB、UTF-8 边界规则同文本。理由：整数参数便于校验；只抽所选页，大文档逐页读时每次调用只解析需要的页，而不是每个 256 KiB 分块都重抽全文；同一选页内分块沿用 Office 的偏移语义。响应：`page_count`（全文页数）、`pages: {start, count, requested}`、`next_page_start`（所选页文本完整且后面还有页时）、`text_layer: present | partial | none`、`text_length`（抽取完成时）、`extracted_as`、`untrusted_content: true`。抽取在 `offset + length`（≤ 8 MiB）处停止，此时 `eof: false`、无 `next_page_start`，按 offset 续读；offset ≥ 8 MiB 且未完为 `archive_limit_exceeded`。
  - **限制**：≤ 20 MiB 整份下载（一次预算内请求，无 Range 模式；§4.1 的 32 MiB + Range 分块仍为后续项），更大返回 `delivered_as: "none"`、`reason: "pdf_too_large"`，不发正文请求。每次调用抽取时限 = 本次调用 25 s Drive 信号扣除已用时间与 5 s 复核预留，至多 10 s（剩余 < 1 s 返回 `storage_read_unavailable`）；页间与页内每 16 个文字块让出计时器后检查（Worker 时钟只在 I/O / 计时器处前进），另外守卫每被调用 4 096 次（token、对象、字符、算子、解码缓冲……，`PDF_DEADLINE_CHECK_EVERY`）比较一次本次调用的时钟与截止时间，所以没有文字块的页、表单 XObject、Type3 CharProc 也在截止时间处停止（workerd 内时钟只反映 pdf.js 最近一次 await 前的时间，那里 CPU 主要由下述按调用累计的上限约束，至多数秒）：超时则所选页在已完成的整页处结束（`pages.count < requested`，`next_page_start` 接续），页内超时丢弃该页，不返回半页；首页即超时返回 `storage_read_unavailable`。续读（`offset > 0`）的 offset 落在本次超时截断之后时返回 `storage_read_unavailable`，带 `next_page_start` 与固定 hint（从该页 `offset 0` 重读），不返回空 eof。每次调用都重新整份下载（≤ 20 MiB provider 字节，不计入交付额度；provider 字节维度属 N4）。
  - **资源上限（恶意文件，独立审查 MAJOR）**：pdf.js 本身不限制解码字节，70 KB 的 deflate 炸弹可解出数百 MB（实测修复前：单页 71 KB → 12 s CPU、13 MB 文本；178 KB 使 128 MB 堆崩溃；100 MB 解码的非文字算子炸弹 8.4 s、约 200 MB ArrayBuffer）。修复：构建时给所钉 `pdfjs-dist` 6.3.289 的 worker 打补丁（`apps/clued-cloud/build/pdfjs-decode-guard.mjs`，`vite.config.ts` 与测试的 esbuild 打包均使用；锚点不符即构建失败；补丁模块导出 `CLUED_PDF_DECODE_GUARD`，缺失时 Worker 拒绝解析 PDF），在每处解码缓冲增长（`DecodeStream.ensureBuffer`：Flate / LZW / RunLength / ASCII85 / Hex / 预测器 / 解密 / 页内容拼接；原生 `DecompressionStream` 路径：页内容流、内嵌 CMap / ToUnicode）、每个内容流 token、每个新缓存的 Name / Cmd、每个 CMap 条目（`CMap.mapOne` 与 `mapCidRange` / `mapBfRange` / `mapBfRangeToArray` 的每个码，按区间在填充前一次计入）、`Parser.getObj` / `makeInlineImage` 构造的每个数组、数组元素、Dict 与 Dict 条目（内容流、间接对象、对象流、xref 恢复共用同一解析器）、加入算子表的每个算子（`OperatorList.addOp`）与路径算子（`buildPath`）、Lexer 返回的每个字符串 / 十六进制串 / 名字的字符数处调用本次抽取的守卫（`AsyncLocalStorage` 区分同一 isolate 内的并发抽取，无上下文的解码直接拒绝）。上限：每流解码缓冲分配 ≤ 16 MiB（单流解码 < 8 MiB），每次调用 ≤ 48 MiB，token ≤ 4 000 000（约 0.6 µs/个，算子炸弹约 2.5 s 内停止），新 Name / Cmd ≤ 200 000，字符串 / 十六进制串 / 名字 / 数组 ≤ 256 Ki 元素；`BrotliDecode` 的同步解码器（无输出上限）一律拒绝，运行时原生 `DecompressionStream` brotli 路径与 Flate 同样计量。解析对象（加权：数组、元素、Dict 条目各 1，每个 Dict 6，至多约 38 B 堆 / 单位）：单个顶层对象（一个内容流操作数如 TJ 数组，或一个间接对象）≤ 512 Ki 单位（约 19 MB），一次调用解析的全部间接对象（pdf.js 为文档缓存，常驻）≤ 1 000 000 单位（约 36 MB），一次调用解析的全部内容流对象（页、表单 XObject、Type3 CharProc、注释外观，即不带 `allowStreams` 的解析器）另加 pdf.js 保留的算子表条目（Type3 CharProc 加载字体时构建并随字体保留：每个算子计 6，每个路径算子计 1）**累计** ≤ 512 Ki 单位（`PDF_CONTENT_OBJECTS_MAX`，约 19 MB）。必须按调用累计而非按操作数计：pdf.js 在一个算子前最多保留 33 个操作数，多余操作数移入 `nonProcessedArgs` 保留到流结束，CharProc 的算子表随字体常驻，按操作数的上限会被同时持有的数量放大；累计上限同时约束构造对象的 CPU。`nonProcessedArgs` 另由补丁限为最近 33 个（一个算子至多能取回的数量）。字符串 / 十六进制串 / 名字字符每次调用 ≤ 4 Mi（单串另有 256 Ki 上限）。CMap 条目（加权）每次调用 ≤ 400 000：内置预定义 CMap 条目计 1，PDF 内嵌 CMap 条目计 4（bfrange 每码一个字符串，ToUnicode 还会再复制进字体），码 > 0xFFFF（稀疏字典数组）再乘 2；实测每个预定义条目约 45 B 堆（含字体的 Unicode 表），内嵌条目 70–250 B，即 CMap 约占 16–20 MB。最大的内置 CMap（GBK2K-V 连同 usecmap 父表）约 6 万条，典型未嵌入 CJK 字体（UniGB-UCS2-H + Adobe-GB1-UCS2）约 5.9 万条。**字形表**（`06d2251a` 复审 MAJOR）：pdf.js 按字体字典里的几个数逐码填充每字体的表，对象与 CMap 上限都看不到：CIDFont `/W` 的每个 `c_first c_last w` 区间与 `/W2` 的每个 `c_first c_last w1y v1x v1y` 区间（`PartialEvaluator.extractWidths`）、CIDToGIDMap 流每 2 字节一项（`readCidToGidMap`）、`IdentityToUnicodeMap.forEach` 从 FirstChar 到 LastChar 的每个码（无 ToUnicode 的 Identity 字体在 `fallbackToSystemFont` 中每码建一项）。CID 至多 0xFFFF（ISO 32000-1 §9.7.4、附录 C），补丁先把每个区间截到 0..0xFFFF（范围外的码从不被查询；复合字体的 `FirstChar` / `LastChar` 同样截断，CIDToGIDMap 只读前 128 KiB），再在填充前把截断后的项数计入每次调用 ≤ 2 000 000 项（`PDF_GLYPH_ENTRIES_MAX`；实测约 8–10 B 堆 / 项，即约 16–20 MB）：一个字体每张表至多 65 536 项，上限使多字体无法相乘；一次调用约可加载 30 个无 ToUnicode 的 Identity 字体，或 10 个 `/W` 与 `/W2` 都覆盖全部 65 536 个 CID 的字体。正常 CID 字体（Identity-H / Identity-V，实际的 `/W`、`/W2` 与 CIDToGIDMap 流，含 ArialMT 这类走 CIDToGIDMap 分支的标准字体名）修复前后文字完全相同。图片解码器（`JpegStream` / `Jbig2Stream` / `JpxStream` / `CCITTFaxStream.decodeImage`）不经 `ensureBuffer`、一次分配整幅图，文字抽取从不需要解码图片（`getTextContent` 跳过图片），故一律拒绝：带 `/Filter /DCTDecode` 的 ToUnicode 流即 `archive_limit_exceeded`；JBIG2 / JPX / CCITT 在 6.3.289 中没有 `readBlock`，文字路径上的读取在分配前即抛错（pdf.js 丢弃该流）。**内嵌字体程序不解析**（`d509f1e3` 复审：Type1 / CFF / TrueType / OpenType 转换、`hmtx` 与字形循环、转换输出缓冲均无上限，只间接受单流解码上限约束）：补丁使 `PartialEvaluator.translateFont` 不再查找 `FontFile` / `FontFile2` / `FontFile3`，字体程序流从不读取、解码或转换，每个非 Type3 字体都走 pdf.js 的未嵌入路径（`Font.fallbackToSystemFont`）；文字映射只用字体字典：`/Encoding`、`/Differences`、ToUnicode、`/Widths` / `/W`、内置预定义 CMap。补丁记下字典声明过字体程序（`cluedEmbeddedFontFile`），使编码选择仍按“已嵌入”处理，且不标记 `missingFile`（否则 Type1 字体中 StandardEncoding 无名的码即使有 ToUnicode 也会变成空格）。补丁模块另导出 `CLUED_PDF_FONT_PROGRAMS = "skipped"`，缺失时 Worker 同样拒绝解析 PDF。Type3 字体是内容流（已按内容流对象、token 与算子表计量），不受影响。**已知漏报（文字丢失，不报错）**：没有 ToUnicode、没有 `/Encoding`（或 `/Differences`）、码只由字体程序自身内置编码命名的 Type1 / Type1C 字体（例如未启用 `\pdfgentounicode` 的旧版 pdfTeX 输出、自定义编码的 CM 字体），其文字原先由 pdf.js 从程序内置编码推出，现在得到码值本身，该页被判为不可靠（`unreliable_pages`）而省略；符号 TrueType 字体原先按 Windows name 记录补 WinAnsi 映射的少数情形同理。有 ToUnicode 或标准编码的字体（常规生产工具的输出几乎都是）不受影响。**可能的错字（未验证）**：经典 pdfTeX 的 Computer Modern（OT1 编码）字体若没有 ToUnicode，文字按码值（ASCII / StandardEncoding）解读，字母数字正确，但连字（ﬁ、ﬂ、ﬀ 等）、短横 / 长横与引号所在的 OT1 码位是别的字符，可能丢字或错字（例如 0x0C 的 fi 是控制符而被去掉，`{` / `|` 处的 en / em dash、`\` / `"` 处的双引号原样输出），而这类少量错字不足以触发 `looksGarbled`；这一点尚未用真实 TeX PDF 验证。实测（修复前后对比，同一文本）：自建 TrueType（Liberation Serif 子集）、CFF（由其字形生成）、Type1（Bitstream Charter）各种组合 20 例，以及 reportlab（TrueType、Type1）、fpdf2（TrueType、CFF）、pdf-lib（TrueType 子集 / 整份、CFF）、pdfkit（TrueType、CFF）的真实输出 10 例：除上述两例（Type1C 与 Type1，内置编码码 1..n，无 `/Encoding` 无 ToUnicode）外文字完全相同；无 ToUnicode 的 Identity-H 字体修复前后都只有字形 ID（不可靠页）。**文字项上限**：`extractPdfText` 的逐项循环按调用计数 pdf.js 返回的文字项（文字段、行尾标记），> 200 000 即 `archive_limit_exceeded`（`PDF_TEXT_ITEMS_MAX`）：pdf.js 为每项做变换与布局，64 MB 堆下约 8–10 µs / 项，而一行 `(a)'` 只需 2 个 token、5 字节解码，token 与解码上限本可放行约 200 万项；实测 110 万行跑到 10 s 截止（16 s CPU），22 万行约 1.4 s 停在上限。任一超限（即使 pdf.js 因 `stopAtErrors: false` 吞掉异常）→ `archive_limit_exceeded`，不返回部分文本。页文字改用 `streamTextContent()`，本次文字量或时限一过即 `reader.cancel()`，pdf.js 停止评估该页。pdf.js 内部的分配 / 栈失败（`RangeError` 等）→ `storage_read_unavailable`，解析器拒绝才是 `document_invalid`。抽取文字去掉 C0/C1 控制符与双向覆盖符 U+202A–202E、U+2066–2069。实测（Node 22，`--max-old-space-size=64` 子进程；本地 workerd 结果一致）：20 / 50 / 300 MB 文字炸弹与 100 MB 算子炸弹 0.1–1.1 s 内 `archive_limit_exceeded`（解码缓冲峰值约 13 MB、堆约 20 MB）；7 MB 文字炸弹 0.4–0.6 s 停在 256 KiB（`complete: false`）；7 MB 算子炸弹（上限内，约 350 万 token）约 2.3–2.6 s 完成；200 次引用同一 1 MB 流、200 MB ToUnicode 炸弹、7 MB 长字符串 / 数组、25 万个不同名字均 `archive_limit_exceeded`，堆均未超 64 MB。独立复审 MAJOR（均 < 1.6 KB、无压缩）：1.4 KB 的 ToUnicode 含一个 `<000000> <FFFFFF> <4100>` bfrange，修复前 1 GB 堆在 29 s 后崩溃，同样的 cidrange 9 s、约 850 MB 堆；1.6 KB 的 ToUnicode（或 FontFile2）流以 `/DCTDecode` 声称 30000 × 30000 JPEG，修复前 RSS 5.2 GB、28 s CPU。修复后四者均约 10 ms 内 `archive_limit_exceeded`，64 MB 堆内（字体程序不再读取后，该 FontFile2 流从不解码，读取正常完成）。第二轮复审 MAJOR（对象构造无总量上限）：8 KB 页 `[ [<<>> ×250 000] ×8 ] TJ`、8 KB 页 `[ [[] ×250 000] ×16 ] TJ`、4 MB 未压缩 Catalog `/Junk` 含 5 组各 20 万个 `<<>>`（xref 路径），修复前在 128 MB 堆均内存耗尽（复审实测峰值 A 527 MB、B 171 MB）；8.5 KB 页 `[ (a ×200 000) ×40 ] TJ` 修复前 3.4 s、堆约 110 MB。修复后四者 0.2–0.5 s 内 `archive_limit_exceeded`（64 MB 堆内）；恰在单对象上限内的 7.4 万个 `<<>>` 操作数与 Catalog 正常完成。第三轮复审 MAJOR（`26ee7e4e`：按操作数的上限被同时持有的操作数放大、`nonProcessedArgs` 从不释放、无文字页内无 CPU / 时间上限），修复前（2 GB 堆实测）：H2（7.8 KB，一个 TJ 前 26 个各 7 万 `<<>>` 的操作数）峰值 481 MB；I2（`[<<>>×70000] n` ×26）482 MB、I3（×10，3.4 KB）196 MB；K（49 KB，一页绘制 6 个各 7.8 MiB 此类行的表单 XObject）1 056 MB、5.1 s 墙钟 / 9.5 s CPU；四者在 64 MB 堆均内存耗尽。Type3 CharProc 保留 26 个 7 万 `<<>>` 的 `d` 操作数峰值 219 MB（64 MB 堆内 5 s 完成），保留 200 万个 `1 w` 算子 476 MB（64 MB 堆耗尽）。修复后（64 MB 堆）：上述六者与 140 万个 `lineto` 的 CharProc 路径均在 0.1–0.3 s 内 `archive_limit_exceeded`，堆峰值约 20 MB（2 GB 堆下约 38 MB，含未回收垃圾）；6 个各 7 MiB `q Q` 的表单 XObject（token 上限内的纯 CPU 页）约 3.1 s 由 token 上限停止，`time_ms: 500` 时约 0.5 s 返回 `storage_read_unavailable`；20 页密集字距调整文本（每 3 个字符一个 TJ 元素，约 6.4 万内容对象单位）0.4–0.6 s 完整抽取。敌意字体程序（各自格式允许的最多 65 535 个字形：FontFile2 TrueType 每字形 26 点、65 535 个 `hmtx` 条目；FontFile3 Type1C 65 535 个各 30 段 `rlineto` 的字形程序；各约 6.3 MB 解码、在单流上限内）：修复前每个字体 0.25–0.8 s 墙钟、0.36–1.0 s CPU、RSS 多 45–60 MB 且整份解码；修复后约 10 ms，未解码任何字体字节，文字经 ToUnicode 完整。`06d2251a` 复审 MAJOR（字形表，64 MB 堆）：1 KB 的 `/W [0 30000000 500]`、`/W2 [0 30000000 -1000 500 880]`（Identity-V）、`/W [-30000000 0 500]`、6 个字体各 `/W [0 4000000 500]`（复审：128 MB 堆亦耗尽）、非 Adobe 且无 ToUnicode 的 `/LastChar 30000000`、100 个无 ToUnicode 的 Identity 字体（65 KB）、40 个 `/W` 与 `/W2` 覆盖全部 CID 的字体，修复前均内存耗尽；3 个各 7 MiB CIDToGIDMap 的字体 1.0–1.3 s 完成、堆约 51 MB（复审实测峰值 76 MB）。修复后：前五者与 CIDToGIDMap 例约 0.2–0.5 s 正常完成（堆约 20–37 MB），100 字体与 40 字体两例约 0.3–0.6 s `archive_limit_exceeded`，30 个 Identity 字体正常完成。64 个小 bfrange 合计超限约 0.1 s 拒绝；恰在上限内的稀疏 bfrange 与 4 个预定义 CJK 字体正常完成，8 个预定义 CJK 字体 `archive_limit_exceeded`（修复前 30 个这样的字体、12 KB 文件即耗尽 64 MB 堆）。**并发**：每个 isolate 同一时刻只做一次 PDF 下载 + 抽取（`withPdfSlot`）：两次并发各持 ≤ 20 MiB 文件与 pdf.js 工作集，合计可能逼近 128 MB。后到的读取至多等 2 s，仍被占用则返回 `storage_read_unavailable`，带固定 hint（稍后重试同一读取）与 `next_page_start`（= 本次 `page_start`）；等待时间计入本次 25 s 信号，抽取时限相应缩短。**合法文件的误拒（已知，整次调用失败，`archive_limit_exceeded`，不返回部分文本）**：单个解码流 > 约 8 MiB（例如未子集化、整份嵌入的 CJK 字体，或极大的单页内容流）；一次调用所选页合计解码 > 约 32 MiB；所选页内容流 token > 4 000 000；新 Name / Cmd > 200 000；单个字符串 / 数组 > 256 Ki 元素；约 6 个以上未嵌入、使用预定义 CJK 编码的不同字体（或 PDF 内嵌的超大 CMap）；字形表合计 > 2 000 000 项（约 30 个以上无 ToUnicode 的 Identity 字体，或 10 个以上 `/W` / `/W2` / CIDToGIDMap 覆盖全部 CID 的字体）；单个对象 > 512 Ki 加权单位（例如数十万元素的 `/W` 数组，或 7.4 万个以上 Dict 的数组）；本次调用解析的间接对象合计 > 1 000 000 单位（极大的页树 / 资源字典 / 字体宽度表）；本次调用所选页的内容流对象与 Type3 算子表合计 > 512 Ki 单位（对象密集的页：逐字形定位的超长 TJ 数组、大量标记内容属性 Dict、被每页多次绘制的大表单 XObject、字形复杂的大 Type3 字体；普通排版文本每页约 3–10 千单位）；本次调用字符串与名字合计 > 4 Mi 字符；本次调用所选页的文字项合计 > 200 000（平均每页 1 万个以上单独定位的文字段；pdf.js 把一段内以及按自然步进逐字形定位的字形合并为一项，20 页密集排版约 1 200 项，逐词或表格单元定位的页约 1–5 千项）；以及字形里含 DCT / JBIG2 / JPX / CCITT 图片的 Type3 字体（pdf.js 加载 Type3 字体时会解码字形图片）。超出截止时间（包括守卫在无文字的页内发现）按时限语义处理：所选页在已完成的整页处结束，首页即超时为 `storage_read_unavailable`。按调用累计的几类（合计解码、token、Name / Cmd、CMap、字形表、间接对象、内容流对象、字符、文字项）可缩小 `page_count` 重试（对象密集的页可一次只读一页）；单个流或单页本身超限则无法读取。**残余风险**：守卫只覆盖文字抽取会走到的路径（未计 token 的非内容流解析仅受字符串 / 数组 / 名字上限约束；内嵌字体程序已不解析）；上限内的合法大文件仍可能占用约 2–3 s CPU 与数十 MB 内存；完全隔离需把抽取移到经 service binding 调用的独立 Worker（本次范围外）。
  - **额度**：交付仍 ≤ 256 KiB 文本，但 > 256 KiB 的 PDF 在任何正文请求前对同一读回执 `reserve` `min(文件大小, 5 MiB)`（数据库上限 5 MiB），窗口将满时拒绝下载（`budget_exhausted`）；`finalize` 仍按交付字节结算。provider 字节维度仍属 N2 / N4。
  - **错误**：需要密码的 PDF、损坏或不是 PDF → `document_invalid`（固定文案，不含解析器文本）；只设所有者密码、无需密码即可打开的 PDF 与任何阅读器一样读取。扫描件 / 纯图片页：该页正文为空，`text_layer: "none"` 或 `"partial"` 并带固定 hint（不做 OCR，§1）。取回正文后仍以空缓存复核根内范围，移出根即丢弃。
- **延后**：原始字节下载链接（`resource_link`）；缩略图 builder 与 Cloudflare Images（host 模式须先实测；Images 需月度计数列）；zip 列目录 / 条目、ODF、`resource_link` 下载端点；provider 字节维度、账号合计与 Owner 可调额度（§7.2 / §7.3，N2 / N4）。

## 5. MCP 工具面

### 5.1 `clued_storage_read`（仍为 `read_content` 等级）

在现有 `connection_id`、`object_id`、`offset`、`length`（`storage-read-agent.ts:60-97`）之上新增可选字段：

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `as` | `auto` / `text` / `raw` / `listing` / `metadata` | `auto` 按 §4.1 |
| `entry` | 字符串，≤ 1000 | zip 条目路径，精确匹配中央目录 |
| `pages` | `"3"`、`"3-10"` | PDF 页范围，≤ 20 页。**实现改为 `page_start` + `page_count`（§4.5 PDF 段）** |
| `page_token` | 封签游标 | `as=listing` 续页 |

- `structuredContent` 只放元数据：`provider_file_id, name, mime_type, declared_mime_type?, size, sha256?, modified_time, format, delivered_as: "text"|"image"|"resource_link"|"resource"|"none", range?, eof?, pages?, page_count?, next_pages?, text_layer_absent?, entry?, entries?[], next_page_token?, media_metadata?, processing?, downscaled?, delivered?: {bytes, sha256}, untrusted_content: true, content?`（`content` 仅文本类，与 P2 兼容）。
- `content` 数组：首元素始终是 `{type:"text", text: JSON(structuredContent)}`；文本类追加文本；图片追加 `{type:"image", data, mimeType}`（≤ 5 MiB）；raw 追加 `resource_link`（§4.4）。
- **新增固定错误码**（沿用 `continuity.ts:1839-1860` 固定文案模式）：`binary_too_large`、`image_too_large`、`archive_limit_exceeded`、`document_invalid`、`entry_not_found`、`entry_encrypted`、`entry_method_unsupported`、`scope_upgrade_required`、`download_link_invalid`。

### 5.2 `clued_storage_browse`

- `stat` 增加 `media_metadata` 与 `readable_as: string[]`（按 §4 与当前 profile / 授权计算）。
- `search` 增加 `text`（≤ 200 字符，转义 `\` 与 `'`）。现有 search 是 Worker 侧目录遍历：每轮取 ≤ `SEARCH_CHUNK = 32` 个目录，用一个 batch 请求列出子项（`'<id>' in parents`，`storage-google-metadata-batch.ts:159`），在 Worker 内按名称 / 类型过滤（`storage-read-agent.ts:410-446`）。
- **选定方案：按父目录分块查询**（m-i）。`text` 存在时，每轮在原有子项列表 batch（继续承担目录遍历、名称与类型过滤）之外，再发一个 batch：同一块中每个目录一部分，查询 `'<id>' in parents and fullText contains '<text>' and trashed = false`（分页规则同 `listFolders`）。命中项是已判定在根内目录的直接子项，仍经 `scopedChildren` 处理多父对象（`storage-read-agent.ts:278-285`）。结果 = 全文命中 ∩ 名称 / 类型条件。
- **不采用全账号查询再用 `inRoot` 过滤**：`drive.readonly` 下它会枚举整个 Drive 的命中，根外命中的元数据进入 Worker，且分页无上界、预算不可预测。
- **预算**：`text` 搜索每轮消耗 2 个子请求（外加分页与多父复核），轮数上限仍为 `SEARCH_ROUNDS = 8`，保留 `SEARCH_RESERVE = 10`（`storage-read-agent.ts:18-21`）；预算或轮数耗尽时返回游标（`complete: false`），与现有语义一致。瞬时失败：Drive 批量请求超时、429 或 5xx 时，读取路径（仅读取，资格探测和执行器不重试）会在 250–750 ms 抖动后重试一次，重试计入 `SUBREQUEST_BUDGET` 并受整次调用 25 s 截止约束；重试后仍失败，搜索在第 1 轮之后把它当作预算耗尽处理（该块回队，返回 `complete: false` 与游标），第 1 轮以及 list / stat / resolve / read 仍失败即拒绝（`storage_read_unavailable`）。祖先遍历（`getFiles`）中的瞬时失败目前仍是致命的（已知限制）。日志只写固定标签 `{event: "storage_read_drive_transient", code, outcome}`。全文检索只覆盖 Drive 已建立索引的文件，响应带 `text_index: "provider"` 并在工具描述中说明可能漏检。
- 因为命中本身泄露正文信息，`text` 需要 `normal` profile 且读取授权 `normal/1` 含 `read_content`，否则 `scope_upgrade_required`。N1。

### 5.3 `clued_storage_submit` 与 `clued_storage_upload_begin`

- `submit`：`create` 文件变体新增互斥的二进制形态（§6.1）；工具描述删去 “Binary upload is not supported”，并说明用户手动上传的文件不可改名、移动或删除（§1.2）。
- **新工具 `clued_storage_upload_begin`**（N3，`create_file` 等级，MCP 工具，MAJOR-2）：输入 `{connection_id, destination_path, mime_type, size, content_sha256}`，输出 `{staging_id, upload_url, method:"PUT", required_headers:{"Content-Type": mime_type, "Content-Length": size}, expires_at}`。语义见 §6.2。工具描述写明：有 shell 的客户端（Claude Code）用 `curl -T <本地文件> -H "Content-Type: <mime>" "<upload_url>"` 上传；没有 shell 的客户端（claude.ai、Claude Desktop 远程连接器中的 Agent）无法发 PUT，只能用内联 `content_base64`（请求体 ≤ 1 MiB，解码后约 ≤ 700 KiB）。
- **路径形式（`20260930233000_storage_relative_paths_v1`，2026-09-30 生产问题）。** `submit` 的 `destination_path` / `source_path`（所有操作，含 `staging_id` / `content_base64` 二进制）与 `upload_begin` 的 `destination_path` 既可写成相对注册根的路径（`90_待归类/x.md`，与 `clued_storage_browse` `resolve` 的形式一致），也可写成根下的完整路径。此前相对路径会入队，随后被云端执行器以 `ARTIFACT_AUTHORITY_RESOLUTION_FAILED` 拒绝。数据库在计算请求摘要之前，按连接所注册 profile 的 `managed_root` 把路径规范为完整路径（`clued_private.storage_path_canonical_v1`）：作业、回执与暂存行都绑定完整路径，相对与完整两种写法得到同一摘要（同一 `job_id` 可互为重放），`upload_begin` 返回存下的完整路径。空段、`.` / `..` 段、结尾 `/`、反斜杠、控制字符、根本身或规范后超过 1000 字符返回 `storage_path_invalid`；根外的绝对路径（`/`、`\`、盘符 `X:` 或 `scheme://` 开头且不在根下）返回 `storage_path_outside_root`。两者都在创建任何暂存行、回执或作业之前返回，不带路径；Worker 先按同一语法规则拒绝，再原样转交数据库。迁移前以相对路径提交并被拒绝的作业，其摘要绑定的是相对路径：同一 `job_id` 再用相对路径提交会成为身份冲突，`inspect` 不受影响，修正后的写入换用新的 `job_id`。legacy `clued_storage_jobs_v1` 不变。
- 新增固定错误码：`storage_binary_upload_disabled`、`upload_url_invalid`、`upload_url_used`、`content_type_mismatch`、`staging_expired`、`storage_path_invalid`、`storage_path_outside_root`；N0 页面错误码（`root_shared_drive`、`root_not_owned`、`root_overlaps_existing`、`root_name_changed`、`onboard_track_name_conflict`、`onboard_effect_ambiguous`）只出现在页面，不进入 MCP。

## 6. 二进制上传（`create`，N3）

### 6.1 输入与授权（M3、m-c）

```
{ operation:"create", target_kind:"file", destination_path, mime_type, content_sha256,
  content_base64 | staging_id }
```

- `content`、`content_base64`、`staging_id` 恰好一个。`mime_type` 只配合后两者；文本 `content` 仍固定 `text/plain`（`create-effect.mjs:68`）。
- **授权**：任何二进制形态（`upload_begin`、PUT 端点、`submit`、执行 admission 四处）须同时满足：写入策略 active 且含 `create_file`（Q2）；该连接有 active 读取授权 `content_profile = normal/1`；**且**连接行 `provider_scope_profile = normal`（与 §8.2 数据段同一条件）。任一不满足返回 `storage_binary_upload_disabled`；已排队二进制作业在执行 admission 再查一次，不满足则拒绝、effect 为 0。文本 create 不受影响。
- 页面：写入策略未激活（不含 `create_file`）时，在开关下写明“上传不可用：尚未开启新建文件”。

### 6.2 传输与暂存（M5、m5、MAJOR-2、m-e、m-l）

- **内联**：`content_base64` 受现有 1 MiB 请求体上限（`continuity.ts:67, 327-333`，不加按工具例外）。Worker 解码后写入同一暂存（下述流程），`submit` 与暂存在同一请求内完成。
- **签名 PUT URL**（Agent 拿不到 `clued_bnd_` bearer，它只存在于 MCP 请求头，由 Worker 取得，`continuity.ts:1528-1529`，所以端点不用 bearer 认证）：
  1. `clued_storage_upload_begin` 经 MCP 正常认证与 §6.1 授权后，插入 `storage_staging_v1` 行（`state='issued'`，记录 owner、connection、Binding、`destination_path`、声明的 size（≤ 20 MiB，Q3）/ sha256 / mime、`expires_at = now + 10 分钟`），**同一事务按声明 size 预占上传额度**（Binding 与 owner 两级，§7.2）。
  2. `upload_url = https://<Clued 主机>/storage/staging/<staging_id>?t=<token>`；token = HMAC-SHA256（独立密钥 `CLUED_STORAGE_STAGING_URL_KEY`）覆盖 `{owner_id, connection_id, binding_id, staging_id, sha256, size, mime, exp}`。URL 进入工具输出与模型上下文，因此必须短时、单次、字节级绑定。
  3. PUT 端点只验签名，不接受也不需要 Binding bearer：签名有效且未过期 → `issued → receiving` CAS（单次使用，第二次 PUT 得 `upload_url_used`）→ 按行内 Binding 重做 §6.1 授权与 Binding / 授权生命周期检查 → `Content-Length` 必须等于声明 size、`Content-Type` 必须等于声明 mime，否则 `storage_job_input_invalid`。
  4. Worker **流式**处理：首块做 §6.3 魔数检查；明文经 `crypto.DigestStream("SHA-256")` 计算摘要；分块 AEAD 以 `FixedLengthStream` 写入 R2；结束时摘要不符 → 删除对象，行置 `rejected`。
  5. 通过后行进入 `validating`，执行 §6.3 暂存后校验，全部通过才置 `ready`；只有 `ready` 行可被 `submit` 引用，且 `submit` 的 Binding、`destination_path`、`mime_type`、`content_sha256` 必须与行一致。
- **AEAD**（m-l）：每个暂存对象独立密钥 `K = HKDF-SHA256(master, salt = staging_id‖":"‖key_salt, info = "clued.storage-staging/1")`，`key_salt` 为数据库对每个暂存行随机生成的 128 位值（不可变，经 `receive` 与执行描述符交给 Worker）；AES-256-GCM，64 KiB 一块，96 位 nonce = 块序号大端计数（密钥按对象唯一，计数 nonce 不会重复）；内联 `staging_id` 由（Binding token, connection, job_id）派生，暂存行在 7 天保留期后被清除时，若该 owner 已有同 `job_id` 的存储作业，内联 begin 以 `storage_job_input_invalid` 拒绝，同一 `staging_id` 永不第二次暂存；AAD = `owner_id‖connection_id‖staging_id‖chunk_index‖is_final`，防截断与重排。`master` 与凭据 vault 分开，可轮换（行记 `key_id`）。
- 作业行与 Queue 消息只含 `content_ref: {staging_id, sha256, size, mime_type}`；request digest 覆盖 `content_ref`。
- **迁移**（m-f）：`…/20260928070005_…account_jobs_v2.sql:150-153` 的提交校验接受 `content_ref` 形态。size / sha256 目前从 `mutation.content` 推导的现行定义**全部**改为对 `content_ref` 作业取 `content_ref.size` / `content_ref.sha256`：`storage_job_provider_attempt_v2`（`20260928072813_…:130-137`，另有 `20260930100000_…:182-183`、`20260930120000_…:466-477` 两次源码补丁）；`storage_verified_result_v2`（`20260928074834_…:254-255`，现行定义为 `20260929200000_…:685-686` 的 `create or replace`，另有 `20260930100000_…:228-229`、`20260930120000_…:478-515` 补丁）；kernel 核验 `resource-center-google-drive-postcondition.mjs:52-55`。N3 迁移以锚点补丁方式修改（与 100000 / 120000 同法，锚点命中数必须等于期望值），并加测试：对每个函数取 `pg_get_functiondef`，断言不存在未受 `content_ref` 分支保护的 `mutation->>'content'` 取 size / sha256。P4 `replace` 的 `20260930120000_…:204-205` 仍只处理文本，不在此列。文本形态不变。
- **生命周期**：`issued` 行 10 分钟未 PUT → `expired`，释放预占（未收到任何字节）；`ready` 未提交 TTL 1 小时；二进制作业 12 小时内未开始执行则取消（`staging_expired`）；作业结算或 effect 开始后删除暂存（恢复只 GET、不重传）；R2 bucket 生命周期 3 天，仅作兜底；清理器按数据库状态删除。

### 6.3 类型检查（M8、m-d）

- **首块魔数拒绝表**（不论声明类型）：`MZ`、ELF（`7F 45 4C 46`）、Mach-O / fat（`FE ED FA CE/CF`、`CE/CF FA ED FE`、`CA FE BA BE`）、`#!`。命中返回 `content_type_mismatch`。
- **暂存后校验**（`validating` 阶段，流式期间做不到，因为 zip 中央目录在文件末尾）：从 R2 解密读回：
  - zip / OOXML / ODF：按 §4.3 Range 模式读 EOCD 与中央目录（同样的绝对上限）；任一条目名（大小写不敏感、规范化 `/` 后）的末段为 `vbaProject.bin`，或 `[Content_Types].xml` 声明 `macroEnabled` 内容类型 → 拒绝；
  - CFB（`D0 CF 11 E0`）：解析目录项，存在名为 `VBA`、`Macros`、`_VBA_PROJECT_CUR` 的 storage → 拒绝；
  - OOXML 读取的 `*.rels` 部件至多 1024 个（`RELS_PARTS_MAX`），超过即以 `content_type_mismatch` 拒绝；`*.rels` 按本地文件头偏移顺序读取，Range 读取按 4 块（256 KiB）对齐窗口并经小型 LRU 缓存，校验阶段的 R2 get 次数以对象窗口数为上限（约每 256 KiB 一次，20 MiB 约 80 次），与条目数无关；
  - 其他类型复核魔数与声明 MIME 一致。任何拒绝 → 删除对象，行置 `rejected`，返回 `content_type_mismatch`；预占不释放（已收到字节）。
- **扩展名 ↔ MIME 绑定**：`destination_path` 扩展名须在允许表中映射到 `mime_type`；魔数须与该 MIME 一致（png / jpeg / gif / webp / pdf / zip / OOXML / ODF / CFB）。`upload_begin` 时先查扩展名与 MIME，PUT 后查魔数。
- **排除**：宏启用类型（docm、xlsm、pptm、dotm、xltm、potm、ppsm、xlam 及 `application/vnd.ms-*.macroEnabled.12`）、可执行与脚本类型、`application/vnd.google-apps.*`。
- HTML / XHTML / SVG 不接受二进制形态；只能走文本 `content`，按 `text/plain` 存储。

### 6.4 执行与核验

- effect：≤ 5 MiB 用 multipart（`create-effect.mjs:86-88`，Content-Type 改为请求 MIME）；更大用 resumable upload，从 R2 流式解密分块上传。session URI 只在内存。中断且无法在同一执行内确认 → `uncertain`，按 `appProperties.clued_intent_id` GET 恢复，绝不重传。
- effect 前取回暂存并重算 sha256，不符 `STORAGE_CONTENT_STAGING_MISMATCH`，effect 为 0。
- 核验（`kernel/host/resource-center-google-drive-postcondition.mjs:52-55, 98-113`）：size / sha256 取自 `content_ref`；`mimeType` 须等于请求值；最终 `sha256Checksum` 不符判 `attention_required`。合同名升为 `clued.storage-create-verified/3`，旧作业按 `/2` 结算。

## 7. 额度

### 7.1 默认值（Q7）

| 维度 | 计量对象 | 默认 | 硬上限 | Owner 可调 | 期 |
| --- | --- | --- | --- | --- | --- |
| 交付字节 / 小时（含下载链接） | 每 Binding | 256 MiB | 2 GiB | 32 MiB – 2 GiB | N1 固定，N4 可调 |
| provider 下载字节 / 小时 | 每 Binding | 512 MiB | 4 GiB | 随上一项 ×2 | 同上 |
| 上传字节 / 小时 | 每 Binding | 256 MiB | 2 GiB | 32 MiB – 2 GiB | N3 / N4 |
| 账号合计（全部 Binding） | 每 owner | 1 GiB 读 / 1 GiB 上传 | 8 GiB | 32 MiB – 8 GiB | N2 / N4 |
| 单次读取 | 每调用 | 文本 256 KiB；图片 5 MiB；下载 32 MiB | 同左 | 不可调 | — |
| 单个上传 | 每作业 | 20 MiB | 20 MiB | 不可调 | N3 |

### 7.2 计量（M9）

- 沿用 P2 做法（`…/20260930060000_storage_read_content_v1.sql:57-63`）：同一 Binding 的正文 admission 用事务级 advisory 锁串行，窗口滚动 1 小时。
- **N1b 已实现（`20260930200000_storage_read_budget_n4.sql`）**：交付字节维度，每 Binding 256 MiB / 小时（固定）。读回执新增 `reserved_bytes`；admission 预占 256 KiB，`clued_storage_read_v1` 新增 `reserve` 动作：Worker 在元数据分类后、正文请求前对同一回执把预占扩到本次最大交付字节（图片 = 文件大小 ≤ 5 MiB），与 admission 取同一 advisory 锁，汇总窗口内其他回执（已结算按 `byte_count`，未结算按 `reserved_bytes`，缺省 256 KiB），超出返回 `storage_read_budget_exhausted`；预占只增不减，仅限本 Binding、10 分钟内的 `read_content` intent；结算按实际交付字节。下述 provider 字节维度、账号合计与新增回执列仍待 N2 / N4。
- **admission 同时预占两项**：交付字节按本次模式单次上限；**provider 下载字节按 32 MiB 全额**。未结算调用在两个维度上都按全额计入；结算后改为实际值。下载链接的预占与结算见 §4.4（签发时预占、端点只结算、过期释放，不双重计费）。
- **账号合计**（N2）：admission 另取 owner 级 advisory 锁（先 owner、后 Binding，固定顺序防死锁），按同样规则预占。
- 读回执新增 `delivered_bytes`、`provider_bytes`、`format`、`mode`、`image_transform`；不记录正文、文件名或条目名（SFC §5.5）。
- 上传（m-e）：`upload_begin` 签发 URL 时（内联形态在请求开始时）按声明 size 预占，PUT 端点只允许 `Content-Length` 等于该值；提交时记账到作业回执。URL 过期且未收到字节 → 释放；已收到字节后被拒或取消 → 不释放（保守）。
- 超额返回 `budget_exhausted`，给出当前额度与“约 N 分钟后恢复”，不暴露其他 Binding 用量。

### 7.3 Owner 可调（N4）

- 新表 `clued_private.storage_budgets_v1`：键 `(owner_id, connection_id)`，列 `read_bytes_per_hour`、`upload_bytes_per_hour`、`image_transforms_per_month`、`budget_generation`、Receipt；行不可变，改动 = 撤销 + 插入。缺行用默认。
- 原生 RPC `clued_storage_budget_v1`（`status` / `set`，CAS `budget_generation`），只接受原生 Owner 会话，数值须在硬上限内；不改写入策略、读取授权、`auth_generation`，不影响排队作业。

## 8. 页面与数据

### 8.1 N0 自助接入（M1、MAJOR-1）

**现状约束**（迁移前缀同上）：

- 连接只能由原生 `clued_storage_account_v1(register)` 对**已有** profile 与**当前** Decision 创建（`20260927073103_…:122-131, 149-151`）；profile 只由 service_role 的 `clued_resource_center_admin_v1` 创建，须 `project_id`、`source_decision_id`、`root_folder_id`、`root_parent_id`，`managed_root` 须以 `/` 或 `X:/` 开头（`20260926134500_…:3-18, 129-151`）；每个 profile 只能有一个未撤销连接（`20260927073103_…:22`）。
- OAuth attempt 的 `connection_id not null`（`20260927075249_…:11`）；describe / prepare 复查连接与 profile 的两个 Decision 仍 CURRENT（`075249:62-68`、`20260926134500_…:302-311`）；083521、145426 包装器都经 connection → profile 取根（`20260927083521_…:217-222`、`20260927145426_…:66-71`）；Worker descriptor 在 start 前就要根 ID 与父 ID（`storage-google-oauth.ts:26-33`），complete 核对根的父 ID（`:153-154`）。
- 策略行须 `source_decision_id`、`decision_version`、非空 `scope_digest`（`20260928051323_…:65-68`）；`storage_policy_scope_digest_v2`（`:125-148`）要求 profile 的 `cloud_runtime` 为 `clued.storage-cloud-runtime/1`、1–32 个 track 且每个有 active 目录 artifact，否则为 NULL；`cloud_runtime` 目前只由 service_role 的 `clued_storage_cloud_qualify_v1` 写入（`20260927104436_…:21-62`）。
- 连接转入 `account_policy` 须满足模式守卫与延迟一致性触发器（`20260928051323_…:207-248`）；`storage_oauth_apps_v1.execution_enabled` 与 `read_enabled` 须为 true（`20260927104436_…:3`、`20260930010000_…:7`）。
- 读 agent 拒绝离过期 ≤ 60 秒的 token（`storage-read-agent.ts:218-220`），因此没有刷新委托的连接约 1 小时后不可用。

所以“新建目录”路径在 OAuth 之前**不存在**可写入 profile 的根 ID，不能沿用“先 register 连接再 OAuth”。N0 采用独立的接入 attempt，所有 canonical 行在最后一个事务中创建。

**对象与顺序**：

1. **页面确认（原生 Owner 会话）**：“新建连接” → 选择根：**新建目录**（默认名 `Clued_资料中心`，可改）或**选择已有目录**（第 3 步 Picker）→ track 名（默认 `资料`、`项目`、`归档`，可增删，1–32 个，规则同 `104436:42-47`）→ 预先勾选的“正常使用”（Q1）与“后台自动续期授权”→ 显示说明 `clued.storage-onboard-disclosure/1`，按钮“确认并连接 Google Drive”。该点击就是下述 Decision 的 `user_confirmed`。说明全文（尖括号为实际值）：
   > 点击“确认并连接 Google Drive”即表示你确认：Clued 使用你 Google 云端硬盘中的「<目录名>」作为资料根目录〔新建时：在“我的云端硬盘”下新建该目录及子目录「<track…>」〕，并以你的名义记录这一决定；你授权的 Agent 可以在该目录内查看目录结构、新建文件和子目录。〔勾选正常使用时：接 §8.2 说明全文。〕〔勾选自动续期时：Clued 会在后台自动续期 Google 授权，直到你关闭或断开连接。〕你可以随时在本页关闭或断开连接。
2. **`clued_storage_onboard_v1(begin)`**：插入 `clued_private.storage_onboard_attempts_v1`：`owner_id`、`session_id`、根选择（`new` + 名称，或 `picked` + 文件夹 ID + Picker 显示名）、tracks、`normal_use_requested`、`default_refresh_requested`、`disclosure_version`、`disclosure_sha256`（实际渲染文本的摘要）、预留 `connection_id`、`expires_at = now + 30 分钟`、`state='begun'`；同时插入 `storage_oauth_attempts_v1`（`purpose='onboard'`、`onboard_attempt_id`、`connection_version=0`）。迁移把 `connection_id` 改为可空，约束 `(purpose='onboard') = (connection_id is null)`。不创建任何 canonical 行。
3. **Picker（仅 `picked`，m-a）**：浏览器 GIS `initTokenClient({scope: drive.file, include_granted_scopes: false})`；回调里把 `tokenResponse.scope` 去重后必须**恰好**等于 `{drive.file}`，否则丢弃该 token（只丢弃，**不** revoke：revoke 会撤销整个“用户 × 客户端”授权，§2.4 第 4 项）。Picker 用文件夹视图、`setAppId(<Cloud 项目编号>)`（否则选中项不会对本应用授权）、`setOAuthToken`、`setDeveloperKey`；token 只在页面内存，选完即丢弃，不发往服务端。Picker 只签发 access token，不产生 refresh token。
4. **Google 同意与回调**：start 用接入 attempt 的描述（预留 `connection_id`、`credential_version=1`、无根 ID），scope 集合按 `normal_use_requested` 取 `normal` 或 `legacy`。新的最外层包装器（§2.4 第 3 项）把 `purpose='onboard'` 的 claim / complete 直接分派给 `clued_private.storage_onboard_oauth_v1`，**不进入** 083521 / 145426 包装器。Worker 换 token，要求 `scopeProfile(授予) !== null`，取 `provider_subject`，以预留 `connection_id` 为上下文封存凭据，调用 `stage_credential`（行 `state='credential_staged'`，记录授予的 profile；claim 计入 §2.4 第 8 项）。
5. **Drive 目录（幂等 effect，Worker，同一回调内）**：每个对象一个角色：`root`、`track:<名称>`。
   - 新建：先查 `appProperties has {key='clued_onboard_attempt_id' and value='<attempt>'}` 且角色相同、未进回收站的对象；恰好 1 个 → 复用；> 1 → `onboard_effect_ambiguous`；0 个 → 先 `effect_intent(role)` 记入行，再创建（root 不指定 parents，即“我的云端硬盘”；track 的父为 root），带 `appProperties {clued_onboard_attempt_id, clued_onboard_role}`，再 `effect_result(role, id, version, parents)`。回调重放或重试只会复用，不会重复创建。
   - 选中根（m-b）：以服务端凭据取 `id,name,mimeType,trashed,driveId,ownedByMe,parents,isAppAuthorized,capabilities(canAddChildren)`：须为文件夹、未进回收站；有 `driveId`（共享盘）→ `root_shared_drive`；`ownedByMe !== true` → `root_not_owned`（N0 不支持他人所有的目录：所有者可移动、删除或改共享，Clued 无法保证）；`parents` 恰好 1 个，作为 `root_parent_id`；`isAppAuthorized`、`canAddChildren` 为真；`name` 须等于第 1 步说明中显示的名称，否则 `root_name_changed`，页面重新确认。**重叠**：Worker 遍历选中根的祖先链（≤ 32 级）与该 owner 同一 `provider_subject` 下每个 active 根的祖先链；选中根等于、位于或包含任一 active 根 → `root_overlaps_existing`。选中根下已有与 track 同名的子目录 → `onboard_track_name_conflict`，页面改名后重试。
   - 失败：调用 `fail`（独立事务）：行置 `failed`，已创建对象列为**孤儿**（ID、角色、时间），页面显示“已在 Drive 中创建但未启用”。Clued 不删除、不移入回收站；30 分钟内可在同一 attempt 重试（复用），过期后删除行内凭据信封，token 计为孤儿（§2.4 第 8 项）。
6. **激活事务 `clued_storage_onboard_v1(activate)`**（原生会话，`session_id` 与 begin 相同，未过期）：取 `owner‖root` advisory 锁（与现有包装器同键），复查行状态、effect 完整、根 ID 不属于任何 active profile，且不在 Worker 报告的祖先链中出现任何 active 根。随后依次，每步各有 Receipt 与 Event，任一步失败整体回滚（之后由 Worker 调 `fail`）：
   1. **Project**：经 `clued_private.project_mutation_core` 当前定义（`p_binding_id = null`，原生 Owner）创建，名称“Clued 资料中心：<目录名>”。
   2. **Decision**：经 `clued_private.record_mutation_core` 创建 `record_type='decision'`、`authority='user_explicit'`、`canonical_scope='project:<id>'`，输入带 `user_confirmed: true`；正文 = 第 1 步说明全文 + 根 ID / 名称 + tracks + 两个勾选项；字段记 `onboard_attempt_id`、`disclosure_version`、`disclosure_sha256`。此后所有复查 `resource_center_decision_current_v1` 都指向它。
   3. **profile**：`managed_root = '/clued-cloud/google-drive/<root_folder_id>'`（满足 `134500:131-133` 的格式；Host `profile_register` 同期拒绝 `/clued-cloud/` 前缀，防冲突），`profile_version = 'clued.storage-onboard/1'`，根 ID、父 ID、`project_id`、`source_decision_id`；同时插入根目录 artifact（`governance`，`delete_authority=false`，版本取 Drive `version`），与 `134500:140-151` 同形。
   4. **track artifacts**：每个 track 一行 `directory`、`ordinary`。
   5. **`cloud_runtime`**：`{contract:'clued.storage-cloud-runtime/1', profile_version, allowed_root_children, source_decision_id, decision_version, receipt_id}`，校验与 `104436:38-54` 相同（track 均已登记）。
   6. **连接**：以预留 ID 插入 `awaiting_provider`、`credential_version=0`、第 2 步 Decision 与其版本；在此状态按 145426 的资格谓词（`:77-82`）计算默认刷新资格；再更新为 `active`：`provider_subject`、`oauth_client_id`、`credential_version=1`、凭据信封、`provider_scope_profile` = 第 4 步授予的 profile（m-c：只有 Google 实际授予 `normal` 才写 `normal`）。
   7. **写入策略**：`storage_account_policies_v2`，`consent_source='native_connection'`，actions 为固定三项，`scope_digest = storage_policy_scope_digest_v2(connection)`（NULL 即回滚），`policy_generation=1`，Decision 与版本，`disclosure_version`，同意与激活 Receipt，`state='active'`；连接 `auth_mode` `legacy → account_policy`、`account_policy_id`、`auth_generation` +1。
   8. **读取授权**：`normal_use_requested` **且**授予 `normal` → `{read, read_content}` + `normal/1`；否则 `{read}` + `text/1`（授予 `legacy` 时页面提示原因，§2.3）。
   9. **默认刷新委托**：勾选且第 6 步有资格 → 插入 `storage_refresh_delegations_v1`，Receipt 类型 `storage_default_refresh`、Event `extension:storage:default_refresh_enable`，与 `145426:101-119` 同形。实现 PR 把该段抽成共享 helper 供 145426 路径与 N0 共用，或逐字复用并加等价测试，二选一。新根无历史，正常情况下一定有资格；没有委托的连接约 1 小时后读写都不可用，页面须明示。
   10. 删除行内凭据信封，行与 OAuth attempt 置 `completed`。
7. **客户端资格（选定：保留已审查快照）**：客户端登记只能是 `reviewed_snapshot`（`20260928051323_…:25`；`20260928060125_…:1-8`），但资格不按 owner 划分（`storage_client_capabilities_v2` 无 owner 列，`051323:40-54`），且公开 https 回调的新 DCR 登记按回调身份继承已审查 lineage（`20260930040000_…:1-21, 44-67`）。因此 claude.ai 等使用公开 https 回调的托管客户端（Claude Desktop 远程连接器等以其实际回调 URI 为准，N2 矩阵记录）由运营方审查一次后，所有 N0 用户都**无需逐人审查**。loopback / localhost 回调的客户端（本机 Claude Code 等）从不继承（`040000:14-15, 23-32`），每个登记都要运营方审查的 link，Owner 自己的这类客户端也一样。N0 不新增自助资格：任何本机程序都能注册 loopback 客户端，自助资格等于“拿到 Binding 就有存储权限”，会取消按客户端的资格与 deny 这一层。结果：名单外用户的 N0 验收用托管客户端；§6.2 的 `curl -T` 路径只对 loopback 登记已审查的用户可用（目前是 Owner）。页面对没有有效 link 的 Binding 显示“该客户端尚未通过存储资格审核”。
8. Owner 现有连接不受影响（N0 测试：现有连接的策略、读取授权、委托、`auth_generation` 不变）。名单外用户以 §2.5 验证通过为前置门槛。

### 8.2 “正常使用”开关（`page.tsx`）

**现状**（`25cfe793`）：四个独立开关“查看目录结构”（`read`）、“读正文”（`read_content`，仅 Clued 创建的文本）、“改名和移动文件”（`modify`，`page.tsx:59-61`）、P4 新增的“覆盖文件内容”（`overwrite`，`:14, 64-66`）。

1. 顶部一个开关 **“正常使用”**：开启 = 读取授权 `{read, read_content}` + `normal/1`；二进制上传随之可用（§6.1）。原四个开关移入“高级”，行为不变；“正常使用”不开启 `modify` 或 `overwrite`。
2. 连接为 `normal`：说明确认后调用 `clued_storage_normal_use_v1`（`enable` / `disable`，CAS `read_generation`，携带 `disclosure_version`）。连接为 `legacy`：同一说明确认后跳转 Google 同意页（`normal` 集合），`complete` 授予 `normal` 时同一事务建立读取授权；授予 `legacy` 时只更新凭据，开关保持关闭并提示原因。
3. 关闭：读取授权回到 `{read}`（Q8），停止读正文、全文搜索与上传；不改 token scope。“撤回全部文件读取授权”与“断开连接”执行 §2.4 第 6 项，文案含“断开该 Google 账号在 Clued 中的所有连接”。
4. 额度：开关下显示每小时读取 / 上传额度，64 MiB / 256 MiB / 1 GiB 三档与自定义（N4）。

**数据**：`storage_read_access_v1` 新增不可变列 `content_profile text not null default 'text/1' check (… in ('text/1','normal/1'))`，读判定器返回。Worker 只有在 `normal/1` **且** `provider_scope_profile = normal` 时启用非 Clued 文件、非文本格式、全文搜索与二进制上传（§6.1）。说明中的目录名取服务端从 Drive 读到的实际名称（m-b），不用固定文字。已有 `read_content` 授权不自动升级（Q10）。等级变更复制读取授权时（`…storage_modify_level_v1.sql:220` 起）须同时复制 `content_profile`。

**说明文案（`clued.storage-normal-use-disclosure/1`，改动即升版本）**：

> 开启后，你授权的 Agent 可以读取「<根目录实际名称>」内的全部文件，包括你手动上传的文件：文本、文档、表格、PDF 的文字，图片内容，压缩包的目录和其中单个文件；其他文件可通过几分钟内有效的下载链接取回原始内容。视频和音频只读取时长、分辨率、大小等信息。Agent 还可以按内容搜索文件，并在该目录中新建图片、PDF、压缩包等文件（每个最多 20 MB），不会覆盖或删除已有文件；你手动上传的文件 Agent 不能改名、移动或删除。
> 读取到的内容会发送给该 Agent 所用的模型服务，已经返回的内容无法收回。
> Google 页面会显示“查看你 Google 云端硬盘中的所有文件”。Clued 服务端只允许访问所选目录，这个限制由 Clued 保证，不由 Google 保证。
> 默认每小时额度：读取 256 MB、上传 256 MB。关闭“正常使用”会立即停止读正文、按内容搜索和上传，但不会收回 Google 授权；“撤回全部文件读取授权”会断开该 Google 账号在 Clued 中的所有连接。

## 9. 威胁模型增量

在 SFC §7（T1–T15）之上：

| # | 威胁 | 缓解 |
| --- | --- | --- |
| N-T1 | 凭据或 Worker 失陷，暴露整个 Drive 正文 | vault AEAD 不变；单一内容通道 + 已判定 ID + 两个 URL builder（§3、§4.2）；无通用 Drive 代理；升级后旧信封无残留（§2.4）；应急步骤“批量 revoke 全部连接 token”；Google 验证 / CASA |
| N-T2 | 内容里的提示注入（PDF 隐藏文字、图片文字、Office 批注） | 所有交付带 `untrusted_content`；Agent 合同 T1 条款适用；destructive 约束不变 |
| N-T3 | 解析器 DoS / zip bomb / XML 实体 | §4.3 绝对上限；拒绝 DOCTYPE；不递归；32 MiB 下载上限；超时失败不返回部分结果 |
| N-T4 | 外流范围扩大 | 新说明与 `disclosure_version`；不自动升级；按客户端 deny（D6）；额度；读回执 |
| N-T5 | TOCTOU 逃出根 | 读后完整祖先复核（§3 第 4 项）；下载端点缓冲后复核，字节离开 Worker 前完成（§4.4） |
| N-T6 | 恶意或伪装上传 | 首块魔数拒绝表、暂存后 zip / CFB 宏校验、扩展名 ↔ MIME 绑定、排除宏与 HTML / SVG（§6.3）；sha256 写后核验 |
| N-T7 | 成本与配额耗尽 | Binding 与 owner 两级额度；provider 字节全额预占；Images 月度上限 |
| N-T8 | scope 混淆 | 精确允许集合；刷新 / 恢复不得改变 profile；数据库与封存集合交叉核对 |
| N-T9 | provider 链接泄露 | 一律不进响应、回执、日志；缩略图 builder 限 host、禁重定向 |
| N-T10 | 暂存残留 | 分块 AEAD、每对象 HKDF 密钥与计数 nonce（§6.2）；TTL 与 3 天兜底生命周期；键不含文件名 |
| N-T11 | 下载链接被转发 | HMAC 绑定 Binding 与版本；≤ 5 分钟、单次使用；端点重做 admission |
| N-T12 | revoke 连带断开 | 只在撤回 / 断开时 revoke，文案明示；N1 前真实账号核实（§2.4 第 7 项）；Picker token 范围不符只丢弃不 revoke（§8.1 第 3 步） |
| N-T13 | 上传 URL 进入模型上下文后被转发 | 10 分钟、单次使用、绑定 Binding / sha256 / size / mime；只能写暂存，提交仍须同一 Binding 经 MCP（§6.2） |
| N-T14 | refresh token 名额被挤出、接入孤儿 | 按账号 × 客户端计数与阈值（§2.4 第 8 项）；接入 effect 幂等并记录孤儿（§8.1 第 5 步） |

### 8.1.9 r4 复审补充（实现 PR 必须满足）

1. **N0 自带 scope 基础件**：§2.2 的 `scopeProfile` 模块（Worker 与 kernel）、连接行 `provider_scope_profile`、读取授权 `content_profile` 与 `normal/1`、正常使用说明，以及读 agent（`storage-read-agent.ts:218`）、执行器（`storage-cloud-executor.ts:42`）、刷新（`storage-google-refresh.ts:56, 77, 89`）三处改为“属于允许集合”，**并入 N0**。否则预先勾选“正常使用”的新连接会因 scope 不等于 `legacy` 而读取失败，首次刷新即进入 `reauthorization_required`。N1 保留重新同意、任意文件读取与 R1–R11。
2. **onboard OAuth 路径复述被绕过包装器的检查**：`storage_onboard_oauth_v1` 必须自行执行 083521 包装器在等锁后的最终会话 / issuer / 过期复核（`083521:246-252`）和一次性 claim 语义，claim 同样计入 §2.4 第 8 项计数。
3. **锁序**：§2.4 第 3 项的延续包装器先取 owner‖root advisory 锁，再 `FOR UPDATE` 连接，最后锁委托行，与 `clued_storage_refresh_manage_v1`（连接 → 委托）一致，避免死锁后留下已换取的孤儿 token。
4. **Canonical 写入必须检查结果并抛错**：激活事务调用 native records API 使用的入口 `record_mutation_with_terminal_guard`（`20260922140000`），不直接调用被多次 `pg_get_functiondef` 修补的原始 core；Project 同理使用其当前入口。每一步检查返回的 receipt `status='committed'`，否则 `raise` 使整个事务回滚（`record_mutation_core` 在 `20260825171129` 约第 455 行捕获异常并返回失败信封，不会自行抛错）。
5. **`issuer_hash` 来源**：激活写 `storage_refresh_delegations_v1` 所需的连接器 `issuer_hash` 取自分派器的 `p_issuer_hash`，记录在接入 attempt 行，并在激活时对照 `storage_oauth_apps_v1`（`execution_enabled` 与 `read_enabled` 为真）复核。

## 10. 分期

每期都是小 PR，迁移编号排在 P4 的 `20260930120000` 之后，路径均为 `apps/clued-cloud/supabase/migrations/`，时间戳由实现 PR 分配。

| 期 | 内容 | 迁移 | 测试 | 验收 |
| --- | --- | --- | --- | --- |
| **N0** 自助接入 | §8.1 全部：接入 attempt、Picker、幂等目录 effect 与孤儿、激活事务（Project → Decision → profile / artifact → `cloud_runtime` → 连接 → 策略 → 读取授权 → 默认刷新委托）；新最外层 OAuth 包装器的 `onboard` 分派 | `storage_onboard_attempts_v1`；`storage_oauth_attempts_v1.connection_id` 可空 + `purpose='onboard'`；`clued_storage_onboard_v1`（begin / stage_credential / effect_intent / effect_result / activate / fail）；Host `profile_register` 拒绝 `/clued-cloud/` 前缀 | 激活任一步失败整体回滚且 canonical 行为 0；回调重放不重复建目录；effect 失败孤儿被记录；`scope_digest` 非空；Picker scope 超集被丢弃且无 revoke 请求；共享盘 / 非本人 / 多父 / 重叠根 / 名称变化 / track 重名各拒绝；授予 `legacy` 时写 `text/1`；默认刷新委托建立且 1 小时后仍可读；Owner 现有连接不变；名单外用户拒绝 | 测试账号在网页上从零完成连接（新建与选择已有各一次），用托管客户端浏览根目录并新建文本文件，2 小时后仍可用 |
| **N1** scope 与任意文件读取 | §2 全部（scope 模块、profile 列、刷新 / 恢复规则、部分授权、重新同意、委托延续、无 revoke 与无残留）；§3（单一通道、M4 应用授权、完整复核、base64 分块）；`content_profile` 与 `clued_storage_normal_use_v1`；页面开关与说明；png / jpeg ≤ 5 MiB；Google 文档、docx、表格文本（zip 核心 + SAX）；全文搜索；Binding 级双维预占 | 连接行 `provider_scope_profile`；`content_profile`（含等级变更复制）；新最外层 OAuth 包装器（委托延续、`onboard` 分派）；attempt 行 `normal_use_requested`、`disclosure_version`；读判定器返回两列；读回执新列 | scope 矩阵（legacy / normal / 部分 / 含 `drive` / 刷新或恢复变 profile）；重新同意失败旧凭据不变；`storage_root_busy`；委托延续四条件；无残留搜索；R1–R11；CI 防漂移（含 kernel 四处）；refresh token 计数阈值；委托延续在最外层包装器；DOCTYPE 拒绝；provider 预占 | **前置**：§2.4 第 7 项 revoke 实测、Google 验证申请已提交。真实账号：手动上传的 `.txt`、docx、Google 文档 / 表格、png 可读；全文搜索命中根内且不返回根外；根外同类文件 `not_found_in_scope` 且无 media 请求；legacy 连接行为不变 |
| **N2** 其余格式 | §4：PDF 文字提取、xlsx / pptx、ODF、Slides / 绘图 export、gif / webp、缩略图 builder 与 Images binding、zip 列目录与条目、音视频元数据、`resource_link` 下载端点；owner 级合计额度 | 下载 `jti` 表；owner 级预占；Images 计数列 | 每种格式正向夹具；zip bomb（绝对上限、Zip64、加密、未知方法、内存模式 10 MB）；缩略图 host / 重定向 / token 外发负向测试；下载链接过期、重放、换 Binding、文件移出根（缓冲后复核丢弃）、未用链接释放预占；PDF Range 分块与内容请求预算；owner 锁顺序 | **真实客户端矩阵**：claude.ai、Claude Desktop、Claude Code 及至少一个其他 MCP 客户端，对 PDF、docx、xlsx、pptx、odt、png、大图、HEIC、zip、mp4 各读一次；每种格式在每个客户端至少文本或图片路径可用；`resource_link` 在不支持的客户端上记录为不可用并在工具描述中说明；记录每个客户端的图片大小上限，若有客户端为 5 MB（十进制），把图片上限改为 5 000 000 字节（NIT） |
| **N3** 二进制上传 | §6：授权条件、`clued_storage_upload_begin` 与签名 PUT URL、内联 1 MiB、每对象密钥分块 AEAD、暂存后宏校验、类型检查、multipart / resumable、核验 `/3`、上传记账 | `storage_staging_v1`（issued / receiving / validating / ready / rejected / expired）；jobs_v2 提交校验；§6.2 所列全部 size / sha256 定义的锚点补丁；核验合同 `/3` | 开关关闭或 profile 非 `normal` 即拒绝（upload_begin、PUT、提交、执行四处）；签名篡改、过期、重放；Content-Length / Content-Type 不符；sha256 不符；魔数拒绝表每项；zip 内 `vbaProject.bin`、CFB `VBA` storage；HTML / SVG；扩展名不符；20 MiB 边界；截断 / 重排分块；未用 URL 释放预占；TTL 与清理；resumable 中断 → GET 恢复不重传；函数定义中无未保护的 `mutation->>'content'` | 真实 Drive：Claude Code 用 `upload_begin` + `curl -T` 上传 png、pdf、zip 各一，`sha256Checksum` 一致；claude.ai 内联上传小 png |
| **N4** 额度与页面收尾 | §7.3 可调额度（含 Images 月度）；页面额度控件；维护文档与 Agent 合同更新 | `storage_budgets_v1`；`clued_storage_budget_v1` | CAS、硬上限、改额度不影响策略与作业 | Owner 在页面调额度后立即生效 |

N0–N4 全部完成并经 Owner 真实验收后，才开工 P5 / P6 / P7。P4 已完成（`25cfe793`）。

## 11. Owner 决定

**Decision `7dbb4c09-c425-4e62-8aca-479dff482acc`（2026-09-30）取代 `7de051b5-5a3e-446e-871a-556f587d06d5`。** Q1–Q3、Q5、Q7–Q10 维持原结论；Q4、Q11 改判；Q6 由照片决定具体化；新增 N0。

| # | 问题 | 结论 |
| --- | --- | --- |
| Q1 | 新连接是否默认开启正常使用 | 连接表单预先勾选，用户可取消（不变） |
| Q2 | 二进制上传等级 | 沿用 `create_file`（不变）；另须“正常使用”开启（§6.1，M3 澄清，不新增写入等级） |
| Q3 | 上传上限与暂存 | 20 MiB，R2 加密暂存（不变）；传输为签名暂存 URL 或内联（§6.2） |
| Q4 | PDF 与原始字节 | **改判**：PDF 默认服务端文字提取、按页范围读取，大 PDF 可逐页读；ODF 走同一 zip / XML 路径；原始字节只通过 Clued 签名的短时下载链接（`resource_link`），不内联长 base64，不给 provider URL |
| Q5 | Office 默认行为 | 默认文本提取（不变）；raw 改为下载链接 |
| Q6 | 超限图片与 HEIC | Drive 缩略图（专用 builder）→ Cloudflare Images binding（按转换计费，有免费额度）→ 拒绝（§4.2） |
| Q7 | 额度默认值 | §7.1（不变） |
| Q8 | 关闭后保留什么 | 保留 `{read}`（不变） |
| Q9 | 对其他用户放行门槛 | Google 受限 scope 验证（含 CASA）通过后（不变）；N1 开工即申请 |
| Q10 | 已有 `read_content` 是否自动升级 | 不升级（不变） |
| Q11 | 升级后旧 refresh token | **改判**：不调用 Google revoke；从数据库硬删除旧凭据信封并测试无副本；revoke 只用于“撤回全部文件读取授权”与断开连接，文案写明断开该 Google 账号在 Clued 的所有连接；N1 前用真实账号核实 Google 行为 |
| N0 | 自助接入 | 新增首期：网页选择 / 新建根 + `native_connection` 策略 + 激活事务内建立 `normal/1` 读取授权；Owner 现有连接不受影响 |

## 12. 依据与核对定位

所有迁移路径前缀为 `apps/clued-cloud/supabase/migrations/`，Worker 路径前缀为 `apps/clued-cloud/worker/`。

| 类别 | 文件与行号 |
| --- | --- |
| OAuth 与 scope | `storage-google-oauth.ts:4, 15, 26-33, 90-165`；`storage-google-refresh.ts:4-6, 56, 73-89`；`storage-google-recovery-oauth.ts:1, 16, 33` |
| scope 完全相等 | `storage-cloud-executor.ts:12, 42`；`storage-cloud-recovery.ts:13, 80`；`storage-google-probe.ts:12, 83`；`storage-read-agent.ts:16, 218-220`；`kernel/host/resource-center-cloud-executor.mjs:18, 141` |
| scope 包含关系 | `kernel/host/resource-center-google-drive-create-effect.mjs:28-31`；`…-modify-effect.mjs:62-65`；`…-replace-effect.mjs:66-69`；`…-metadata.mjs:3-8` |
| 读路径与搜索 | `storage-read-agent.ts:17-31`（常量、预算、错误码），`:120`（base64），`:255-285`（根范围、子项），`:288-383`（正文、export、Range），`:410-446`（search）；`storage-google-metadata-batch.ts:5, 150-175` |
| 读取授权与额度 | `20260930010000_storage_read_access_v1.sql:7, 9-24, 140-160`；`20260930060000_storage_read_content_v1.sql:50-63`；`20260930080000_storage_modify_level_v1.sql:28-48, 205-220` |
| 接入对象图 | `20260926134500_resource_center_artifact_authority_v1.sql:3-18, 129-151, 302-311`；`20260927073103_resource_center_account_connection_v1.sql:3-22, 122-151`；`20260927104436_resource_center_cloud_bridge_v1.sql:3-4, 21-62`；`20260928051323_resource_center_account_policy_foundation_v2.sql:8-25, 40-68, 125-148, 207-248`；`20260928063442_resource_center_policy_transition_v2.sql:437-440` |
| 客户端资格 | `20260928051323_…:17-25, 40-54`；`20260928060125_resource_center_client_capability_admin_v2.sql:1-8`；`20260930040000_storage_client_redirect_identity_v3.sql:1-67` |
| 凭据、OAuth 包装链与委托 | `20260927075249_resource_center_oauth_connector_v1.sql:9-22, 40-124`；`20260927083521_resource_center_account_refresh_v1.sql:4-13, 32-39, 211-250`；`20260927145426_resource_center_default_refresh_consent_v1.sql:56-132`；`20260927211632_resource_center_credential_recovery_oauth_v1.sql:1-10, 143-170`；`20260927183650_resource_center_directory_probe_v1.sql:106-119` |
| M1 写入核心 | `20260825171129_clued_m1_runtime_contracts.sql:135, 282, 327`（`record_mutation_core` 的 `user_confirmed`）；`20260924120000_project_lifecycle_successor_v2.sql`（`project_mutation_core` 当前定义） |
| 工具与传输 | `storage-agent-tools.ts`；`continuity.ts:67, 327-333, 1512-1529, 1839-1860` |
| create 执行与核验 | `kernel/host/resource-center-google-drive-create-effect.mjs:48-91`；`…-postcondition.mjs:52-134`；`20260928070005_…account_jobs_v2.sql:150-153`；`20260928072813_…account_cloud_v2.sql:96-137`；`20260928074834_…verified_settlement_v2.sql:25, 254-255`；`20260929200000_…directory_sharing_v1.sql:452, 685-686`；`20260930100000_…modify_execution_v1.sql:160-240`；`20260930120000_storage_overwrite_v1.sql:204-205, 455-526` |
| 页面 | `apps/clued-cloud/app/storage/connections/page.tsx` |
| 运维文档 | `docs/maintenance/resource-center-account-connection.md:84-117, 220-230, 473` |
| 上位合同 | `development/contracts/storage/StorageFullCapability.v0.1.md` §3–§9 |
