# Clued Storage 正常使用合同 v0.1

## 0. 文档边界与实施门槛

- **类型**：与实现、迁移和验收直接绑定的工程合同。它不是上线证明，也不是任何阶段的实施授权。
- **状态**：**CANDIDATE（r3）**。r2 独立审查的 1 个 BLOCKER、9 个 MAJOR、8 个 MINOR 与 NIT 已按 §0.2 处理；Owner Decision `7dbb4c09-c425-4e62-8aca-479dff482acc` 取代 `7de051b5`（§11）；待再次独立审查。
- **源码基线**：`229f73b`（PR #414 合并后的 `main`；P3 A/B 已合并，P4 `replace` 在 PR #415 / 分支 `claude/storage-p4`，未合并）。
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

### 0.2 r2 审查处理索引

| 编号 | 核对位置（`229f73b`） | 处理 |
| --- | --- | --- |
| B1 | Google revoke 按“用户 × 客户端”作用 | §2.4 第 4–6 项（Q11 改判） |
| M1 | `…/20260930010000_storage_read_access_v1.sql:13` `account_policy_id not null` FK；策略只由 `…/20260928063442_…policy_transition_v2.sql:437-440`（`reviewed_transition`）与 `…/20260930080000_storage_modify_level_v1.sql:205-213`（`native_level_change`）插入；`native_connection` 仅见于 check（`…/20260928051323_…policy_foundation_v2.sql:69`）；profile 只来自 Host 同步（`…/20260926134500_…artifact_authority_v1.sql:140-146`） | §8.1 N0 |
| M2 | `…/20260927145426_…default_refresh_consent_v1.sql:77-82`（只对 `awaiting_provider` 且 `credential_version=0`）；`…/20260927083521_…account_refresh_v1.sql:234-236`（complete 关闭根下全部委托）、`:225`（complete 已调用 `storage_root_quiet_v1`） | §2.4 第 3 项 |
| M3 | 二进制上传原只挂 `create_file` | §6.1 |
| M4 | 读路径只靠 Google 403/404 判定“非 Clued 文件”（`storage-read-agent.ts:334-349`），未检查 `isAppAuthorized` | §3 第 3 项、R10 |
| M5 | `continuity.ts:67, 327-333`（全局 `MAX_JSON_BYTES`，无按工具例外）；`…/20260928072813_…account_cloud_v2.sql:130-137` 从 `mutation.content` 重算 size / sha256 | §6.2 |
| M6 | 客户端对 image / resource 块支持不一 | §4、§5.1、N2 验收 |
| M7 | 缩略图 URL 不在 `www.googleapis.com` | §3 第 2 项、§4.2 |
| M8 | 声明类型可伪造 | §6.3 |
| M9 | 预占按交付上限，provider 下载可超 | §7.2 |
| m1 | `storage-google-recovery-oauth.ts:1, 16, 33` 复用 `createStorageGoogleOAuth` 的常量 scope | §2.2 第 7 项 |
| m2 | `create-effect.mjs:30-31`、`modify-effect.mjs:64-65`、`metadata.mjs:3-8` 含 scope 字面量 | §2.2 第 5 项 |
| m3 | `storage-read-agent.ts:21` `SUBREQUEST_BUDGET = 50` | §3 第 4 项 |
| m4 | xlsx export 无 Range；比率限制不可靠；XML 实体 | §4.3 |
| m5 | R2 生命周期与作业 TTL 未对齐 | §6.2 |
| m6 | `fullText contains` | §5.2（N1） |
| m7 | 验证 / CASA 起点 | §2.5 |
| m8 | 用户上传文件不可改 | §1.2 |
| NIT | 迁移路径、base64 分块（`storage-read-agent.ts:120`、`storage-google-oauth.ts:15`）、维护文档行号 | §12、§3 第 7 项 |

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

### 2.1 现状（`229f73b`）

- 连接流程要求授予集合**完全等于** `{drive.file, drive.metadata.readonly}`：`apps/clued-cloud/worker/storage-google-oauth.ts:4, 101-102, 135-136`；封存时写入常量（`:160`）。
- 同样的“完全相等”：`storage-google-refresh.ts:4, 6, 56, 77, 89`；`storage-cloud-executor.ts:12, 42`；`storage-cloud-recovery.ts:12, 79`；`storage-google-probe.ts:12, 83`；`storage-read-agent.ts:16, 218`；`kernel/host/resource-center-cloud-executor.mjs:16, 125`。
- 包含关系（已容忍超集）：`kernel/host/resource-center-google-drive-create-effect.mjs:28-31`、`…-modify-effect.mjs:62-65`、`…-metadata.mjs:3-8`。
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
5. **CI 防漂移**：kernel 三处包含关系校验（`create-effect.mjs:30-31`、`modify-effect.mjs:64-65`、`metadata.mjs:3-8` 的 `NAMESPACE_READ_SCOPES`）改为从 kernel 镜像模块导入。新测试断言 scope URL 字面量只出现在两个模块、测试夹具与本机试点凭据文件中；Worker 与 kernel 模块导出值逐项相等。
6. 连接行新增 `provider_scope_profile text not null default 'legacy' check (… in ('legacy','normal'))`，由 `complete` 事务按 Worker 计算值写入，随 `credential_version` CAS 更新。读判定器在 admission 中返回；Worker 开启凭据后与封存集合交叉核对，不一致返回 `storage_read_unavailable`。
7. **恢复 OAuth**（`storage-google-recovery-oauth.ts` 复用 `createStorageGoogleOAuth`，`:16, 33`）：`describe` 返回封存 profile，恢复只请求该 profile 的集合；`complete` 授予 profile 不等于封存 profile 时失败，凭据不变。恢复不得升级或降级（N1 测试）。

### 2.3 同意流程与部分授权

- 请求参数不变：`access_type=offline`、`prompt=consent`、`include_granted_scopes=false`、S256 PKCE；scope 按本次意图取集合。
- 用户可在同意页取消勾选。`complete` 按实际授予：等于 `normal` → `normal`；等于 `legacy` → `legacy`，页面提示“未授予‘查看云端硬盘中的所有文件’，正常使用未开启”；其他 → 现有 `scope_mismatch`。

### 2.4 已连接用户的重新同意

1. 完成前连接保持 `legacy`，一切照旧；读非 Clued 文件得到 `scope_upgrade_required`（指向页面开关）。不强制迁移，不停服。
2. 走“对同一连接重新授权”（`createStorageGoogleOAuth.start(connection_id, …)`）。新凭据在 `complete` 事务中以 `credential_version` +1 原子替换；任何一步失败，旧凭据与连接原样保留（N1 必测）。
3. **忙碌判定与刷新委托延续**（M2）：
   - 忙碌判定直接用 `complete` 包装器已调用的 `storage_root_quiet_v1`（`…/20260927083521_…account_refresh_v1.sql:32-39, 225`），不另写并行检查。`prepare` 时先调用一次同一函数以尽早提示；`storage_root_has_unresolved_mutation` 在页面映射为 `storage_root_busy`“稍后再试”。
   - 不复用 `default_refresh_consent`（只对 `awaiting_provider` 且 `credential_version=0` 有效，`…default_refresh_consent_v1.sql:77-82`）。改为在 complete 包装器（现 `:229-236` 关闭根下全部委托）内新增**延续规则**：本次 attempt 是对同一连接的重新同意，且该连接的委托在事务开始时 `enabled=true`，且 `provider_subject`、`oauth_client_id`、`root_folder_id` 与 prepare 快照均未变 → 只保留该连接的委托（`version` +1），写独立 Receipt `storage_refresh_delegation_carry`；根下其他委托照旧关闭。任一条件不满足 → 与现在一样关闭。
   - 执行器按 `credential_version` 取凭据（`storage-cloud-executor.ts:33-36` 版本不符即拒绝）。实现 PR 须证明已排队但尚未 prepared 的作业在执行时读取当前 `credential_version`，不会因换凭据被误判失败；否则 prepare 同样返回 `storage_root_busy`。
4. **升级后不调用 Google revoke**（B1、Q11）。Google 的 revoke 很可能撤销整个“用户 × 客户端”授权，连同刚获得的新 token。改为：`complete` 事务用新信封覆盖 `storage_connections_v1.credential_envelope`（`…/20260927075249_…oauth_connector_v1.sql:109`），旧信封在数据库中不再有任何副本。
5. **无残留测试**（N1 必测）：升级后对 `clued_private` 与 `public` 全部 `jsonb` / `text` / `bytea` 列搜索旧信封密文与其 `m1_sha256` 摘要以外的任何片段，命中数 = 0。已知只存摘要的位置（目录探测 `…/20260927183650_…directory_probe_v1.sql:113`）按摘要处理；刷新 claim 只把信封交给 Worker、不落表（`…account_refresh_v1.sql:144-147`），测试同样覆盖 refresh / probe / recovery attempt 行、Receipt 与 Event 载荷。维护文档写明：被覆盖的行版本在 VACUUM 前仍在堆中，PITR 备份按保留期保留；旧 refresh token 在 Google 侧仍有效，但 Clued 不再持有可解密副本。
6. **revoke 只用于两处**：“撤回全部文件读取授权”（revoke 后以 `legacy` 集合重新同意）与“断开连接”。两处的确认文案必须写明：**“这会断开该 Google 账号在 Clued 中的所有连接，其他连接需要重新授权。”** 其他连接随后刷新得到 `invalid_grant`，按现有“无效凭据需重新同意”处理（`docs/maintenance/resource-center-account-connection.md:112-114`）。关闭“正常使用”开关本身不缩小 token scope，文案须说明。
7. **N1 前置核实**：实现者用真实 Google 账号验证：同一客户端先授予 A（legacy）、再授予 B（normal），revoke A 的 refresh token 后 B 是否失效；revoke B 后同账号其他连接是否失效。结果写入维护文档。结果与本节假设不同时只能收紧文案，不得恢复升级后 revoke。

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

**PDF 提取**：在 Worker 内用 pdf.js 的无 DOM 构建（如 `unpdf`）。≤ 32 MiB 整份经 `admittedContent` 下载；更大文件用 pdf.js 按需 Range 加载，每次调用 provider 字节仍 ≤ 32 MiB，超出返回 `binary_too_large` 并提示缩小页范围。响应带 `page_count`、`pages`、`next_pages`。CPU 超时返回 `storage_read_unavailable`，不返回部分结果；N2 PR 实测 128 MB 内存与 CPU 上限下的最大可处理规模并写入维护文档。

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
- 下载端点重新执行 admission（读取授权仍为 `normal/1`、连接与 profile、按客户端 deny、额度）并重走 §3 第 4 项的祖先遍历，再经 `admittedContent` 流式转发；原始文件 ≤ 32 MiB，超出 `binary_too_large`。字节按实际下载计入额度。
- ≤ 1 MiB 的 raw 可改为内联 embedded resource（`blob`）；图片仍用 MCP image。

**Worker 资源**：单次调用 provider 下载 ≤ 32 MiB（含 export、zip 条目、Office 部件、PDF、原图）。流式读取、超限即取消（沿用 `capped`，`storage-read-agent.ts:313-326`）。

## 5. MCP 工具面

### 5.1 `clued_storage_read`（仍为 `read_content` 等级）

在现有 `connection_id`、`object_id`、`offset`、`length`（`storage-read-agent.ts:60-97`）之上新增可选字段：

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `as` | `auto` / `text` / `raw` / `listing` / `metadata` | `auto` 按 §4.1 |
| `entry` | 字符串，≤ 1000 | zip 条目路径，精确匹配中央目录 |
| `pages` | `"3"`、`"3-10"` | PDF 页范围，≤ 20 页 |
| `page_token` | 封签游标 | `as=listing` 续页 |

- `structuredContent` 只放元数据：`provider_file_id, name, mime_type, declared_mime_type?, size, sha256?, modified_time, format, delivered_as: "text"|"image"|"resource_link"|"resource"|"none", range?, eof?, pages?, page_count?, next_pages?, text_layer_absent?, entry?, entries?[], next_page_token?, media_metadata?, processing?, downscaled?, delivered?: {bytes, sha256}, untrusted_content: true, content?`（`content` 仅文本类，与 P2 兼容）。
- `content` 数组：首元素始终是 `{type:"text", text: JSON(structuredContent)}`；文本类追加文本；图片追加 `{type:"image", data, mimeType}`（≤ 5 MiB）；raw 追加 `resource_link`（§4.4）。
- **新增固定错误码**（沿用 `continuity.ts:1839-1860` 固定文案模式）：`binary_too_large`、`image_too_large`、`archive_limit_exceeded`、`document_invalid`、`entry_not_found`、`entry_encrypted`、`entry_method_unsupported`、`scope_upgrade_required`、`download_link_invalid`。

### 5.2 `clued_storage_browse`

- `stat` 增加 `media_metadata` 与 `readable_as: string[]`（按 §4 与当前 profile / 授权计算）。
- `search` 增加 `text`（≤ 200 字符）：转为 Drive `fullText contains '<转义>'`（转义 `\` 与 `'`），与现有名称 / 类型条件 AND；结果逐个经 `inRoot` 过滤，沿用 `SEARCH_CHUNK` / `SEARCH_ROUNDS` 与子请求预算（`storage-read-agent.ts:18-21`）。因为命中本身泄露正文信息，`text` 需要 `normal` profile 且读取授权 `normal/1` 含 `read_content`，否则 `scope_upgrade_required`。N1。

### 5.3 `clued_storage_submit`

`create` 文件变体新增互斥的二进制形态（§6.1）；工具描述删去 “Binary upload is not supported”，并说明用户手动上传的文件不可改名、移动或删除（§1.2）。

## 6. 二进制上传（`create`，N3）

### 6.1 输入与授权（M3）

```
{ operation:"create", target_kind:"file", destination_path, mime_type, content_sha256,
  content_base64 | staging_id }
```

- `content`、`content_base64`、`staging_id` 恰好一个。`mime_type` 只配合后两者；文本 `content` 仍固定 `text/plain`（`create-effect.mjs:68`）。
- **授权**：任何二进制形态（含暂存端点 §6.2）须同时满足：写入策略 active 且含 `create_file`（Q2）；**且**该连接有 active 读取授权 `content_profile = normal/1`（即“正常使用”开关开启）。开关关闭后，暂存与提交立即返回 `storage_binary_upload_disabled`；已排队二进制作业在执行 admission 再查一次，不满足则拒绝、effect 为 0。文本 create 不受影响。
- 页面：写入策略未激活（不含 `create_file`）时，在开关下写明“上传不可用：尚未开启新建文件”。

### 6.2 传输与暂存（M5、m5）

- **内联**：`content_base64` 受现有 1 MiB 请求体上限（`continuity.ts:67, 327-333`，不加按工具例外），解码后约 ≤ 700 KiB。适合模型直接生成的小文件。
- **暂存端点**：`PUT /storage/staging/{connection_id}`，用与 MCP 相同的 Binding bearer 认证；头 `Content-Length`（≤ 20 MiB，Q3）、`Content-Type`、`X-Clued-Content-SHA256`。Worker **流式**处理：
  - 首块做 §6.3 魔数检查；
  - 明文经 `crypto.DigestStream("SHA-256")` 计算摘要；
  - 分块 AEAD（AES-GCM，64 KiB 一块，AAD = `owner_id‖connection_id‖staging_id‖chunk_index‖is_final`，防截断与重排），以 `FixedLengthStream` 写入 R2；密钥与凭据 vault 分开；
  - 结束时摘要与声明不符 → 删除对象，返回 `storage_job_input_invalid`。
  - 成功返回 `{staging_id, sha256, size, expires_at}`；私有表 `storage_staging_v1` 记录 owner、connection、Binding、sha256、size、mime、状态。
- 内联形态也由 Worker 写入同一暂存，因此作业行与 Queue 消息只含 `content_ref: {staging_id, sha256, size, mime_type}`；request digest 覆盖 `content_ref`。`staging_id` 单次使用，须与 `content_sha256` 一致。
- **迁移**：`…/20260928070005_…account_jobs_v2.sql:150-153` 的提交校验接受 `content_ref` 形态；`…/20260928072813_…account_cloud_v2.sql:130-137` 的 provider attempt 期望值对 `content_ref` 作业取 `content_ref.size` / `content_ref.sha256`，不再从 `mutation.content` 重算。文本形态不变。
- **生命周期**：未提交暂存 TTL 1 小时；二进制作业 12 小时内未开始执行则取消（`staging_expired`）；作业结算或 effect 开始后删除暂存（恢复只 GET、不重传，不需要字节）；R2 bucket 生命周期 3 天，严格长于上述两个 TTL，仅作兜底；清理器按数据库状态删除。

### 6.3 类型检查（M8）

- **通用魔数拒绝表**（不论声明类型）：`MZ`、ELF（`7F 45 4C 46`）、Mach-O / fat（`FE ED FA CE/CF`、`CE/CF FA ED FE`、`CA FE BA BE`）、`#!`；CFB（`D0 CF 11 E0`）中含 `VBA` 或 `Macros` storage；zip 中任一路径含 `vbaProject.bin`。命中返回 `content_type_mismatch`。
- **扩展名 ↔ MIME 绑定**：`destination_path` 扩展名须在允许表中映射到 `mime_type`；魔数须与该 MIME 一致（png / jpeg / gif / webp / pdf / zip / OOXML / ODF / CFB）。
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
- **admission 同时预占两项**：交付字节按本次模式单次上限；**provider 下载字节按 32 MiB 全额**。未结算调用在两个维度上都按全额计入；结算后改为实际值。下载链接签发时按文件 size 预占交付字节，端点结算。
- **账号合计**（N2）：admission 另取 owner 级 advisory 锁（先 owner、后 Binding，固定顺序防死锁），按同样规则预占。
- 读回执新增 `delivered_bytes`、`provider_bytes`、`format`、`mode`、`image_transform`；不记录正文、文件名或条目名（SFC §5.5）。
- 上传在暂存完成时按 size 预占、提交时记账到作业回执；被拒或取消不释放（保守）。
- 超额返回 `budget_exhausted`，给出当前额度与“约 N 分钟后恢复”，不暴露其他 Binding 用量。

### 7.3 Owner 可调（N4）

- 新表 `clued_private.storage_budgets_v1`：键 `(owner_id, connection_id)`，列 `read_bytes_per_hour`、`upload_bytes_per_hour`、`image_transforms_per_month`、`budget_generation`、Receipt；行不可变，改动 = 撤销 + 插入。缺行用默认。
- 原生 RPC `clued_storage_budget_v1`（`status` / `set`，CAS `budget_generation`），只接受原生 Owner 会话，数值须在硬上限内；不改写入策略、读取授权、`auth_generation`，不影响排队作业。

## 8. 页面与数据

### 8.1 N0 自助接入（M1）

现状：新连接无法在网页上建立。`storage_read_access_v1.account_policy_id` 是 not null FK（`…/20260930010000_storage_read_access_v1.sql:13`）；策略只由已审查的 transition 与等级变更插入；`native_connection` 同意来源从未插入；profile / 根只来自 Host 同步。

N0 新增：

1. **网页流程**（`apps/clued-cloud/app/storage/connections/`）：“新建连接” → 选择根：**新建目录**（默认，名称 `Clued_资料中心`，可改）或**选择已有目录**（Google Picker 文件夹模式，浏览器端用只含 `drive.file` 的 GIS 短时 token，该 token 不发往服务端；服务端只收到文件夹 ID）→ 预先勾选的“正常使用”（Q1）与说明 → Google 同意。
2. **prepare** 记录意图（profile 集合、根选择、`normal_use_requested`、`disclosure_version`）在服务端 attempt 行，不由回调参数决定。
3. **complete**：Worker 换 token 后，新建目录（`drive.file` 下 `isAppAuthorized` 自然为真）或对 Picker 选中的 ID 用服务端凭据复核 `isAppAuthorized` / `canAddChildren`（`storage-google-oauth.ts:145-152`）。
4. **激活事务**（新原生 RPC `clued_storage_onboard_v1`，只接受原生 Owner 会话）在同一事务内依次创建：`resource_center_profiles_v1`（新增原生来源；`managed_root` 对纯云端连接的表示与所属 Project 由 N0 PR 定义并经审查，不得与 Host 路径冲突）→ 连接行（凭据、`provider_scope_profile`）→ `storage_account_policies_v2`（`consent_source = 'native_connection'`，actions = `{inspect, create_file, create_topic}`，与现有基线同集）→ `storage_read_access_v1`（勾选 → `{read, read_content}` + `normal/1`；未勾选 → `{read}` + `text/1`）。每步各有 Receipt；任一步失败整体回滚。
5. Owner 现有连接不受影响（N0 测试：现有连接的策略、读取授权、委托、`auth_generation` 不变）。名单外用户以 §2.5 验证通过为前置门槛。

### 8.2 “正常使用”开关（`page.tsx`）

**现状**：三个独立按钮“查看目录结构”（`read`）、“读正文”（`read_content`，仅 Clued 创建的文本）、“改名和移动文件”（`modify`），见 `:131-199, 246-258`。

1. 顶部一个开关 **“正常使用”**：开启 = 读取授权 `{read, read_content}` + `normal/1`；二进制上传随之可用（§6.1）。原三个按钮移入“高级”，行为不变。
2. 连接为 `normal`：说明确认后调用 `clued_storage_normal_use_v1`（`enable` / `disable`，CAS `read_generation`，携带 `disclosure_version`）。连接为 `legacy`：同一说明确认后跳转 Google 同意页（`normal` 集合），`complete` 授予 `normal` 时同一事务建立读取授权；授予 `legacy` 时只更新凭据，开关保持关闭并提示原因。
3. 关闭：读取授权回到 `{read}`（Q8），停止读正文、全文搜索与上传；不改 token scope。“撤回全部文件读取授权”与“断开连接”执行 §2.4 第 6 项，文案含“断开该 Google 账号在 Clued 中的所有连接”。
4. 额度：开关下显示每小时读取 / 上传额度，64 MiB / 256 MiB / 1 GiB 三档与自定义（N4）。

**数据**：`storage_read_access_v1` 新增不可变列 `content_profile text not null default 'text/1' check (… in ('text/1','normal/1'))`，读判定器返回。Worker 只有在 `normal/1` **且** `provider_scope_profile = normal` 时启用非 Clued 文件、非文本格式与全文搜索。已有 `read_content` 授权不自动升级（Q10）。等级变更复制读取授权时（`…storage_modify_level_v1.sql:220` 起）须同时复制 `content_profile`。

**说明文案（`clued.storage-normal-use-disclosure/1`，改动即升版本）**：

> 开启后，你授权的 Agent 可以读取「Clued_资料中心」内的全部文件，包括你手动上传的文件：文本、文档、表格、PDF 的文字，图片内容，压缩包的目录和其中单个文件；其他文件可通过几分钟内有效的下载链接取回原始内容。视频和音频只读取时长、分辨率、大小等信息。Agent 还可以按内容搜索文件，并在该目录中新建图片、PDF、压缩包等文件（每个最多 20 MB），不会覆盖或删除已有文件；你手动上传的文件 Agent 不能改名、移动或删除。
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
| N-T5 | TOCTOU 逃出根 | 读后完整祖先复核（§3 第 4 项）；下载端点重走 |
| N-T6 | 恶意或伪装上传 | 通用魔数拒绝表、扩展名 ↔ MIME 绑定、排除宏与 HTML / SVG（§6.3）；sha256 写后核验 |
| N-T7 | 成本与配额耗尽 | Binding 与 owner 两级额度；provider 字节全额预占；Images 月度上限 |
| N-T8 | scope 混淆 | 精确允许集合；刷新 / 恢复不得改变 profile；数据库与封存集合交叉核对 |
| N-T9 | provider 链接泄露 | 一律不进响应、回执、日志；缩略图 builder 限 host、禁重定向 |
| N-T10 | 暂存残留 | 分块 AEAD、独立密钥；TTL 与 3 天兜底生命周期；键不含文件名 |
| N-T11 | 下载链接被转发 | HMAC 绑定 Binding 与版本；≤ 5 分钟、单次使用；端点重做 admission |
| N-T12 | revoke 连带断开 | 只在撤回 / 断开时 revoke，文案明示；N1 前真实账号核实（§2.4 第 7 项） |

## 10. 分期

每期都是小 PR，迁移编号排在 P4 的 `20260930120000` 之后，路径均为 `apps/clued-cloud/supabase/migrations/`，时间戳由实现 PR 分配。

| 期 | 内容 | 迁移 | 测试 | 验收 |
| --- | --- | --- | --- | --- |
| **N0** 自助接入 | §8.1 网页选择 / 新建根；`native_connection` 策略；激活事务内建立读取授权 | profile 原生来源；`clued_storage_onboard_v1`；attempt 行记录根选择与意图 | 事务任一步失败整体回滚；Picker ID 不可授权时拒绝；Owner 现有连接不变；名单外用户拒绝 | 测试账号在网页上从零完成连接，可浏览根目录并新建文本文件 |
| **N1** scope 与任意文件读取 | §2 全部（scope 模块、profile 列、刷新 / 恢复规则、部分授权、重新同意、委托延续、无 revoke 与无残留）；§3（单一通道、M4 应用授权、完整复核、base64 分块）；`content_profile` 与 `clued_storage_normal_use_v1`；页面开关与说明；png / jpeg ≤ 5 MiB；Google 文档、docx、表格文本（zip 核心 + SAX）；全文搜索；Binding 级双维预占 | 连接行 `provider_scope_profile`；`content_profile`（含等级变更复制）；complete 包装器委托延续；attempt 行 `normal_use_requested`、`disclosure_version`；读判定器返回两列；读回执新列 | scope 矩阵（legacy / normal / 部分 / 含 `drive` / 刷新或恢复变 profile）；重新同意失败旧凭据不变；`storage_root_busy`；委托延续四条件；无残留搜索；R1–R11；CI 防漂移（含 kernel 三处）；DOCTYPE 拒绝；provider 预占 | **前置**：§2.4 第 7 项 revoke 实测、Google 验证申请已提交。真实账号：手动上传的 `.txt`、docx、Google 文档 / 表格、png 可读；全文搜索命中根内且不返回根外；根外同类文件 `not_found_in_scope` 且无 media 请求；legacy 连接行为不变 |
| **N2** 其余格式 | §4：PDF 文字提取、xlsx / pptx、ODF、Slides / 绘图 export、gif / webp、缩略图 builder 与 Images binding、zip 列目录与条目、音视频元数据、`resource_link` 下载端点；owner 级合计额度 | 下载 `jti` 表；owner 级预占；Images 计数列 | 每种格式正向夹具；zip bomb（绝对上限、Zip64、加密、未知方法、内存模式 10 MB）；缩略图 host / 重定向 / token 外发负向测试；下载链接过期、重放、换 Binding、文件移出根；owner 锁顺序 | **真实客户端矩阵**：claude.ai、Claude Desktop、Claude Code 及至少一个其他 MCP 客户端，对 PDF、docx、xlsx、pptx、odt、png、大图、HEIC、zip、mp4 各读一次；每种格式在每个客户端至少文本或图片路径可用；`resource_link` 在不支持的客户端上记录为不可用并在工具描述中说明 |
| **N3** 二进制上传 | §6：授权条件、内联 1 MiB、暂存端点、分块 AEAD、类型检查、multipart / resumable、核验 `/3`、上传记账 | `storage_staging_v1`；jobs_v2 提交校验；cloud_v2 attempt 期望值；核验合同 `/3` | 开关关闭即拒绝（暂存、提交、执行三处）；sha256 不符；魔数拒绝表每项；宏 / HTML / SVG；扩展名不符；20 MiB 边界；截断 / 重排分块；TTL 与清理；resumable 中断 → GET 恢复不重传 | 真实 Drive：Claude Code 经暂存端点上传 png、pdf、zip 各一，`sha256Checksum` 一致；claude.ai 内联上传小 png |
| **N4** 额度与页面收尾 | §7.3 可调额度（含 Images 月度）；页面额度控件；维护文档与 Agent 合同更新 | `storage_budgets_v1`；`clued_storage_budget_v1` | CAS、硬上限、改额度不影响策略与作业 | Owner 在页面调额度后立即生效 |

N0–N4 全部完成并经 Owner 真实验收后，才开工 P5 / P6 / P7。P4 按其自身合同推进。

## 11. Owner 决定

**Decision `7dbb4c09-c425-4e62-8aca-479dff482acc`（2026-09-30）取代 `7de051b5-5a3e-446e-871a-556f587d06d5`。** Q1–Q3、Q5、Q7–Q10 维持原结论；Q4、Q11 改判；Q6 由照片决定具体化；新增 N0。

| # | 问题 | 结论 |
| --- | --- | --- |
| Q1 | 新连接是否默认开启正常使用 | 连接表单预先勾选，用户可取消（不变） |
| Q2 | 二进制上传等级 | 沿用 `create_file`（不变）；另须“正常使用”开启（§6.1，M3 澄清，不新增写入等级） |
| Q3 | 上传上限与暂存 | 20 MiB，R2 加密暂存（不变）；传输改为暂存端点（§6.2） |
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
| OAuth 与 scope | `storage-google-oauth.ts:4, 15, 90-162`；`storage-google-refresh.ts:4-6, 56, 73-89`；`storage-google-recovery-oauth.ts:1, 16, 33` |
| scope 完全相等 | `storage-cloud-executor.ts:12, 42`；`storage-cloud-recovery.ts:12, 79`；`storage-google-probe.ts:12, 83`；`storage-read-agent.ts:16, 218`；`kernel/host/resource-center-cloud-executor.mjs:16, 125` |
| scope 包含关系 | `kernel/host/resource-center-google-drive-create-effect.mjs:28-31`；`…-modify-effect.mjs:62-65`；`…-metadata.mjs:3-8` |
| 读路径 | `storage-read-agent.ts:17-31`（常量、预算、错误码），`:120`（base64），`:228-286`（根范围），`:288-383`（正文、export、Range、403/404 判定） |
| 读取授权与额度 | `20260930010000_storage_read_access_v1.sql:7, 13-14, 227-244`；`20260930060000_storage_read_content_v1.sql:3-63`；`20260930080000_storage_modify_level_v1.sql:28-48, 205-220` |
| 策略与接入 | `20260928051323_resource_center_account_policy_foundation_v2.sql:69`；`20260928063442_resource_center_policy_transition_v2.sql:437-440`；`20260926134500_resource_center_artifact_authority_v1.sql:130-146` |
| 凭据与委托 | `20260927073103_resource_center_account_connection_v1.sql:16-20`；`20260927075249_resource_center_oauth_connector_v1.sql:98-109`；`20260927083521_resource_center_account_refresh_v1.sql:32-39, 144-167, 225-236`；`20260927145426_resource_center_default_refresh_consent_v1.sql:70-90`；`20260927183650_resource_center_directory_probe_v1.sql:106-119` |
| 工具与传输 | `storage-agent-tools.ts:22-24, 70-73`；`continuity.ts:67, 327-333, 1512-1540, 1839-1860` |
| create 执行与核验 | `kernel/host/resource-center-google-drive-create-effect.mjs:48-91`；`…-postcondition.mjs:52-134`；`20260928070005_resource_center_account_jobs_v2.sql:150-153`；`20260928072813_resource_center_account_cloud_v2.sql:130-137` |
| 页面 | `apps/clued-cloud/app/storage/connections/page.tsx:7-14, 131-199, 240-258` |
| 运维文档 | `docs/maintenance/resource-center-account-connection.md:84-117, 220-230, 473` |
| 上位合同 | `development/contracts/storage/StorageFullCapability.v0.1.md` §3–§9 |
