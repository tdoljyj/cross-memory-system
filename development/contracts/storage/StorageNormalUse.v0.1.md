# Clued Storage 正常使用合同 v0.1

## 0. 文档边界与实施门槛

- **类型**：与实现、迁移和验收直接绑定的工程合同。它不是上线证明，也不是任何阶段的实施授权。
- **状态**：**CANDIDATE（r1）**，待独立审查与 Owner 审查。
- **源码基线**：`229f73b`（PR #414 合并后的 `main`；P3 A/B 已合并，P4 `replace` 在 PR #415 / 分支 `claude/storage-p4`，未合并）。
- **延续 Task**：`2aa57e7c-9960-45bc-a6f2-ba0c7d74ec9a`；不新建 Program。
- **Owner 决定**：Decision `dc594258`（2026-09-30）。原意：接入 Google Drive 必须让 Owner 和以后所有用户都能正常使用。要点：
  1. 直接申请 `drive.readonly`（与现有 `drive.file`、`drive.metadata.readonly` 并存）；连接后资料根（Clued_资料中心）内所有文件可读，包括用户手动上传的文件；服务端仍把访问限制在资料根内；已连接用户需在 Google 同意页重新确认一次。
  2. “正常使用”的最低标准：读根内任意文件；常见格式可用（文本、Office / PDF、图片直接可看，zip 可列目录并读单个条目，视频只读元数据）；Agent 可通过 `create` 上传二进制文件；额度按正常使用设定（每小时数百 MiB 量级），Owner 可调；页面上**一个开关**即可开启。
  3. 顺序：先于剩余全部写入阶段（P5 trash、P6 目录 move、P7 adopt）。P4（replace，PR #415）独立完成，不受本合同阻塞。

### 0.1 修订关系

本文件是 `StorageFullCapability.v0.1.md`（下称 **SFC**）的修订件，属于同一 Storage Task。被修订条款在对应阶段上线时生效；上线前原条款继续有效。

| SFC 原条款 | 原内容 | 修订后 | 生效期 |
| --- | --- | --- | --- |
| §4 D1、§9 D1 | 先实测 Google Picker | **作废**，改为直接申请 `drive.readonly`（§2） | N1 |
| §3.1 “不在范围内：二进制上传” | 不做 | `create` 支持二进制（§6） | N3 |
| §5.4 只支持文本；其余 `format_unsupported`；256 KiB / 8 MiB | 仅文本 | 按格式矩阵（§4）；额度改为 §7 | N2 / N4 |
| §8 P2、P7 “Scope 变化：取决于 D1” | 待定 | P2 的“已有文件正文”由 N1 覆盖；P7 仍需另行决定写入 scope（§1.2） | N1 |
| §8 分期顺序 | P5–P7 依次推进 | N1–N4 全部完成前，不开工 P5 / P6 / P7 | 即时 |

**实施门槛**：沿用 SFC §8：每期 PR + CI + 独立审查、Owner 批准合并、Owner 批准生产迁移与发布、Owner 批准开关与真实验收，分别进行，任何一期不自动进入下一期。

## 1. 目标与非目标

### 1.1 目标

1. 连接完成、开启“正常使用”后，Agent 能读取资料根内**任意**文件，不再只限 Clued 自建文件。
2. 常见格式都有确定行为（§4 矩阵），不再对 PDF / Office / 图片一律返回 `format_unsupported`。
3. Agent 能新建二进制文件（图片、PDF、zip、Office 等），写后按 sha256 核验。
4. 额度足够日常整理资料使用，Owner 可以调整。
5. Owner 在页面上一次操作即可开启全部上述能力；已连接用户只需额外完成一次 Google 同意。

### 1.2 非目标

- **不申请 `drive` 或 `drive.metadata`。** `drive.readonly` 只能读；修改、移动、trash 非 Clued 创建的文件仍做不到。P7 是否申请写入 scope，由 Owner 另行决定。
- 不改变根范围模型：仍是一个登记根，按 provider ID 父链判定（SFC §5.2）。
- 不做全文搜索（Drive `fullText contains`）；`search` 仍只按名称和类型。
- 不做 PDF 文字提取、OCR、音视频转码或抽帧（见 §10 Q4）。
- 不做二进制 `replace`。P4 保持 UTF-8 文本 `replace`，二进制覆盖另立合同。
- 不改本机 Host 试点凭据 `kernel/host/resource-center-google-drive-credential.mjs:2-3`（设备侧独立凭据，继续只接受旧集合）。
- 不改变共享 / ACL、永久删除、跨根操作的既有禁令。

## 2. Google scope 变更

### 2.1 现状（`229f73b`）

- 连接流程申请并要求 token 响应的 scope **集合完全等于** `{drive.file, drive.metadata.readonly}`：`apps/clued-cloud/worker/storage-google-oauth.ts:4, 101-102, 135-136`；凭据封存时写入的是常量而不是实际授予值（`:160`）。
- 同样的“完全相等”校验还出现在：
  - `apps/clued-cloud/worker/storage-google-refresh.ts:4, 6, 56, 77, 89`（刷新前后）；
  - `apps/clued-cloud/worker/storage-cloud-executor.ts:12, 42`；
  - `apps/clued-cloud/worker/storage-cloud-recovery.ts:12, 79`；
  - `apps/clued-cloud/worker/storage-google-probe.ts:12, 83`；
  - `apps/clued-cloud/worker/storage-read-agent.ts:16, 218`；
  - `kernel/host/resource-center-cloud-executor.mjs:16, 125`。
- 包含关系校验（已容忍超集）：`kernel/host/resource-center-google-drive-create-effect.mjs:28-31`、`resource-center-google-drive-modify-effect.mjs:62-65`、`resource-center-google-drive-metadata.mjs:3-8`。
- 连接时要求根对象 `isAppAuthorized === true` 与 `canAddChildren`（`storage-google-oauth.ts:147-152`）。本合同保留这两项。

### 2.2 精确允许集合

定义两个 **scope profile**，授予集合必须**恰好等于**其中之一：

| profile | 集合 | 能力 |
| --- | --- | --- |
| `legacy` | `drive.file` + `drive.metadata.readonly` | 现有全部能力；正文只限 Clued 自建文件 |
| `normal` | `drive.file` + `drive.metadata.readonly` + `drive.readonly` | 另可读取根内任意文件正文 |

规则：

1. 新增单一模块 `apps/clued-cloud/worker/storage-google-scopes.ts`（Worker）与 `kernel/host/resource-center-google-scopes.mjs`（kernel 镜像），导出 `scopeProfile(value): "legacy" | "normal" | null`：去重、排序后与两个集合逐一比较，含 `drive`、`drive.metadata` 或任何其他 scope 一律返回 `null`。
2. §2.1 所列所有“完全相等”处改为 `scopeProfile(x) !== null`。凭据封存改为写入**实际授予**的规范化集合，不再写常量。
3. 需要读非 Clued 文件正文的代码路径，额外要求 `scopeProfile === "normal"`。写路径两种 profile 都接受。
4. **刷新不得改变 profile。** 刷新响应带 `scope` 时，其 profile 必须等于封存凭据的 profile；不等（升级或降级）一律按失败处理，要求重新同意。
5. **CI 防漂移**：新增一个测试，断言 scope URL 字面量只出现在上述两个模块、测试夹具和本机试点凭据文件中。
6. 数据库记录 profile：连接行新增 `provider_scope_profile text not null default 'legacy' check (… in ('legacy','normal'))`，由 OAuth `complete` 事务按 Worker 计算的 profile 写入，并随 `credential_version` 一起 CAS 更新。读判定器在 admission 中返回该值；Worker 开启凭据后再与封存集合交叉核对，不一致返回 `storage_read_unavailable`。

### 2.3 同意流程与 Google 的部分授权

- 请求参数不变：`access_type=offline`、`prompt=consent`、`include_granted_scopes=false`、S256 PKCE。scope 参数按本次意图取 `legacy` 或 `normal` 集合。
- Google 同意页允许用户**取消勾选**个别 scope。`complete` 按实际授予值处理：
  - 等于 `normal` → 以 `normal` 连接；
  - 等于 `legacy` → 以 `legacy` 连接（能力同今天），页面提示“未授予‘查看云端硬盘中的所有文件’，正常使用未开启”；
  - 其他 → 保持现有 `scope_mismatch` 失败。

### 2.4 已连接用户的重新同意

1. **在完成重新同意之前**，已有连接保持 `legacy`：凭据、刷新委托、写入策略、读取授权、排队作业全部照旧，Agent 读非 Clued 文件继续得到 `content_not_accessible`（提示文案改为指向页面的“正常使用”开关）。不强制迁移，不停服。
2. 重新同意沿用现有“对同一连接重新授权”路径（`createStorageGoogleOAuth.start(connection_id, …)`）。新凭据在 `complete` 事务中以 `credential_version` +1 原子替换旧凭据；**任何一步失败，旧凭据与连接原样保留**（N1 必测）。
3. 维护文档写明：一般性的重新授权会被未解决的文件围栏阻塞，并会关闭常驻刷新委托直到再次启用（`docs/maintenance/resource-center-account-connection.md:113-117, 224`）。本流程要求：
   - 有 prepared / started / uncertain 作业时拒绝，返回 `storage_root_busy`，页面提示稍后再试；
   - `prepare` 时把当前刷新委托状态作为 `default_refresh_consent` 带入，重新同意后委托保持原状，不让用户额外操作；
   - 执行器在执行时按 `credential_version` 取凭据（`storage-cloud-executor.ts:35-37` 会拒绝版本不符），实现 PR 须证明排队中的 create / rename / move 作业不会因换凭据被误判失败，否则同样按 `storage_root_busy` 拒绝。
4. 成功替换后，对**旧** refresh token 调用 Google revoke（尽力而为，写 Receipt；失败不回滚新凭据）。说明：Google 按“用户 × 客户端”保留有限数量的 refresh token，旧 token 不主动撤销会一直有效。
5. **降级**：页面提供“撤回全部文件读取授权”（§8），执行 revoke 后以 `legacy` 集合重新同意。关闭“正常使用”开关本身**不会**缩小 token 的 scope，文案须说明。

### 2.5 Google 受限 scope 审核

- `drive.readonly` 与现有的 `drive.metadata.readonly` 同属 Google 受限（restricted）scope。应用面向外部用户正式使用前，须通过 OAuth 应用验证，并按 Google 要求完成安全评估（CASA，通常每年一次）。以 Google 当期政策为准，N1 前由实现者核对并记录到维护文档。
- 未完成验证前：Testing 状态只能给名单内测试用户使用，且 refresh token 7 天过期；未验证的 Production 状态会显示“未经验证的应用”警告并有用户数上限。
- 因此：**Owner 与测试用户可在 N1 后使用；“所有用户”以验证通过为前置门槛**（§10 Q9）。验证申请须更新 scope 说明、用途陈述与演示视频，覆盖 `drive.readonly`。

## 3. 服务端根范围：`drive.readonly` 下的强制

`drive.readonly` 让凭据能读整个 Drive。根范围完全由 Clued 服务端保证，规则沿用 SFC §5.2，并加强为**结构性**约束：

1. **判定不变**：`storage-read-agent.ts:228-276` 的 `inRoot`：每个对象的每条父链都须在 32 级内按 provider ID 到达登记根；多父对象任一父链在根外即拒绝；缺失或不可见视为根外；快捷方式不跟随；回收站对象不可读正文；共享盘对象视为根外。
2. **单一内容通道**：新增 `admittedContent(fileId)` 封装。它只接受本次调用中已通过 `inRoot` 的 ID 集合里的 ID，并且是唯一能构造 `alt=media`、`/export`、Range 请求和缩略图请求的函数。Drive URL 只能由内部 builder 生成（固定 host `www.googleapis.com`，路径白名单 `/drive/v3/files/{id}`、`/drive/v3/files/{id}/export`），调用方不能传入 URL。
3. **读后复核**：取回字节后、返回前，再 GET 一次该对象的 `parents,trashed`。若已不在根内或已进回收站，丢弃字节，返回 `not_found_in_scope`（缩小 TOCTOU 窗口；线性化点仍按 SFC §5.1）。这次 GET 计入子请求预算。
4. **不暴露 provider URL**：`webContentLink`、`thumbnailLink`、`exportLinks`、导出 URL、resumable session URI 都不进入工具响应、回执或日志。
5. **错误码不区分根外与不存在**：一律 `not_found_in_scope`（SFC §5.2 第 6 项）。

**负向测试（N1 必过，合成 provider 中令 token 对根外文件“可读”）**：

| # | 场景 | 期望 |
| --- | --- | --- |
| R1 | 根外 `.txt`（父链到 My Drive 根） | `not_found_in_scope`；`alt=media` 请求数 = 0 |
| R2 | 多父对象，一条父链在根外 | 同上 |
| R3 | 根内快捷方式指向根外文件 | `shortcut_not_followed`；对目标的请求数 = 0 |
| R4 | 共享盘文件 ID | `not_found_in_scope` |
| R5 | 父链超过 32 级 / 成环 | `not_found_in_scope` |
| R6 | 父链校验后、读后复核前被移出根 | `not_found_in_scope`；字节不返回 |
| R7 | zip 条目名为 `../x`、绝对路径 | 只作为名称返回，不影响任何 provider 请求 |
| R8 | 直接调用内容通道且 ID 未经 `inRoot` | 抛错；测试断言无 fetch |
| R9 | `legacy` 连接读非 Clued 文件 | `content_not_accessible`；不因为 token 实际可读而放行 |

## 4. 读取格式矩阵

判定顺序：先按 Drive `mimeType`；对通用类型（`application/octet-stream`）再按扩展名与魔数识别；魔数与声明不符时按魔数处理，响应带 `declared_mime_type`。所有内容一律带 `untrusted_content: true`（SFC §5.4、T1）。

| MIME / 类型 | 默认行为 | 单次上限 | 备注 |
| --- | --- | --- | --- |
| `text/*`、JSON、XML、YAML、JavaScript、SVG（按文本） | 文本按字节范围内联（现有逻辑） | 256 KiB | UTF-8 边界裁剪沿用 `storage-read-agent.ts:362-376` |
| Google 文档 | export `text/markdown`，不支持时回退 `text/plain` | 256 KiB / 段；export 10 MB | `exported_as` 标明 |
| Google 表格 | export `xlsx` 后走 xlsx 文本提取，每个工作表输出 CSV 段 | 同上 | 不用 `text/csv` export，它只导出第一个工作表 |
| Google 幻灯片 | export `text/plain` | 同上 | |
| Google 绘图 | export `image/png`，按图片处理 | 同图片 | |
| 其他 Google 原生（Forms、Sites、Maps…） | `format_unsupported`，附元数据 | — | |
| PDF | 原始字节，作为 MCP embedded resource（`application/pdf`） | 8 MiB | 超出返回 `binary_too_large`；不做文字提取（Q4） |
| OOXML：docx / xlsx / pptx | 默认 `as=text`：服务端从 OOXML 提取文本（docx 段落，xlsx 共享字符串 + 各表单元格，pptx 各页文字）；`as=raw` 返回原始字节 | 文本 256 KiB / 段；原始 8 MiB | 解析复用 zip 读取器及其全部限制（Q5） |
| 旧版 doc / xls / ppt、odt / ods / odp | 只支持 `as=raw` | 8 MiB | `as=text` 返回 `format_unsupported` |
| 图片：png / jpeg / gif / webp | MCP image content | 5 MiB 且长边 ≤ 8000 px | 超出：尝试 Drive 缩略图（长边 2048）；不可用返回 `image_too_large`（Q6） |
| 图片：heic / tiff / bmp | 缩略图（png / jpeg），否则 `as=raw` | 同上 | |
| zip（`application/zip`、`application/x-zip-compressed`） | `as=listing`：列条目；`entry=<路径>`：读单个条目，条目按本矩阵再判定一次 | 见下 | 嵌套 zip 不递归，返回 `format_unsupported` |
| 其他压缩包（rar、7z、tar、gz） | `format_unsupported`，附元数据 | — | |
| `video/*` | 只返回元数据：Drive `videoMediaMetadata`（`durationMillis`、`width`、`height`）、`size`、`md5Checksum` / `sha1Checksum` / `sha256Checksum`、`modifiedTime` | 无字节 | Drive 仍在处理时 `media_metadata: null, processing: true` |
| `audio/*` | 只返回 size、校验和、modifiedTime | 无字节 | Drive 不提供音频时长 |
| 其他二进制 | `format_unsupported`，附元数据；`as=raw` 允许 | 8 MiB | |

**zip 限制（防 zip bomb）**，服务端强制，任一超出返回 `archive_limit_exceeded`：

- 只用 Range 读取：先读末尾 ≤ 64 KiB 找 EOCD / Zip64 EOCD，再按偏移读中央目录；中央目录 ≤ 4 MiB；条目数 ≤ 10 000，`as=listing` 每页 500 条，游标沿用 SFC §5.3 的封签方式。
- 只支持 stored（0）和 deflate（8），其他返回 `entry_method_unsupported`；加密条目返回 `entry_encrypted`。
- 单条目解压后 ≤ 32 MiB；**实际**解压比 ≤ 100:1（流式计数，不只信声明值）；单次调用累计解压 ≤ 32 MiB。超限立即中止流。
- 条目名只作为不可信字符串返回：规范化 `/`，标记含 `..`、绝对路径或控制字符的条目 `unsafe_name: true`，不据此构造任何请求。
- OOXML 文本提取用同一套限制；XML 解析禁用外部实体，单个 XML 部件 ≤ 16 MiB。

**Worker 资源**：单次调用从 provider 下载 ≤ 32 MiB（含 export、zip 条目、Office 部件）。流式读取、超限即取消（沿用 `capped`，`:314-326`）。CPU 超时返回 `storage_read_unavailable`，不返回部分结果。

## 5. MCP 工具面

### 5.1 `clued_storage_read`（扩展，仍为 `read_content` 等级）

输入在现有 `connection_id`、`object_id`、`offset`、`length`（`storage-read-agent.ts:60-97`）之上新增，全部可选：

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `as` | `auto`（默认）/ `text` / `raw` / `listing` / `metadata` | `auto` 按 §4 默认行为 |
| `entry` | 字符串，≤ 1000 | zip 条目路径，按中央目录精确匹配 |
| `page_token` | 封签游标 | `as=listing` 续页 |

`offset` / `length` 对文本单位为字节（上限 256 KiB）；对 `raw` 为原始字节范围（上限 8 MiB）。超过单次上限的文件按范围分次读取，响应带 `range` 与 `eof`。

**响应**：

- `structuredContent`：只放元数据，不放 base64。

  ```
  { provider_file_id, name, mime_type, declared_mime_type?, size, head_revision_id?, sha256?, md5?, modified_time,
    format: "text"|"google_export"|"office_text"|"image"|"pdf"|"binary"|"zip_listing"|"zip_entry"|"media_metadata",
    delivered_as: "text"|"image"|"resource"|"none",
    range?, eof?, entry?, entries?[], next_page_token?, media_metadata?, processing?,
    delivered: { bytes, sha256 }?, downscaled?: { width, height }, untrusted_content: true,
    content?   // 仅文本类，保持与 P2 响应兼容
  }
  ```

- `content` 数组：第一个元素始终是 `{type:"text", text: JSON(structuredContent)}`；二进制时追加一个元素：
  - 图片：`{type:"image", data:<base64>, mimeType}`；
  - PDF / Office raw / 其他 raw：`{type:"resource", resource:{uri:"clued-storage://<connection_id>/<file_id>[?entry=…]", mimeType, blob:<base64>}}`。
- base64 解码后单次 ≤ 8 MiB（图片 ≤ 5 MiB），即 base64 文本约 ≤ 10.7 MiB；`delivered.sha256` 是本次交付字节的 sha256，供 Agent 核对。
- 客户端不支持 image / resource 内容时，Agent 仍能看到元数据；这属于客户端能力差异，不另开旁路。

**新增固定错误码**（沿用 `continuity.ts:1839-1860` 的固定文案模式）：`binary_too_large`、`image_too_large`、`archive_limit_exceeded`、`entry_not_found`、`entry_encrypted`、`entry_method_unsupported`、`scope_upgrade_required`（`legacy` 连接或读取授权不是 `normal/1` 时读非 Clued 文件，替代原 `content_not_accessible` 文案）。

### 5.2 `clued_storage_browse`

`stat` 增加 `media_metadata`（图片 `imageMediaMetadata.width/height`，视频 `videoMediaMetadata`），以及 `readable_as: string[]`（按 §4 与当前 profile 计算，例如 `["text"]`、`["image","raw"]`、`["metadata"]`），便于 Agent 先选模式再读。

### 5.3 `clued_storage_submit`（create 二进制，§6）

`create` 文件变体新增互斥的二进制形态，见 §6.1。工具描述删去 “Binary upload is not supported”。

## 6. 二进制上传（`create`）

### 6.1 输入

```
{ operation:"create", target_kind:"file", destination_path,
  content_base64: <标准 base64，无换行>, mime_type: <允许列表内>, content_sha256: <64 位小写 hex> }
```

- `content` 与 `content_base64` 恰好一个。`mime_type` 只能配合 `content_base64`；文本 `content` 仍固定为 `text/plain`（`create-effect.mjs:68`）。
- 服务端解码后重算 sha256，与 `content_sha256` 不符返回 `storage_job_input_invalid`；按魔数核对 `mime_type`（png / jpeg / gif / webp / pdf / zip / OOXML），不符返回 `content_type_mismatch`。
- **允许列表**：§4 矩阵中的图片、PDF、zip、OOXML、旧版 Office、OpenDocument、`text/*`、JSON、音视频常见类型。拒绝可执行与脚本类型（如 `application/x-msdownload`、`application/x-sh`、`application/vnd.microsoft.portable-executable`），以及 `application/vnd.google-apps.*`（不做转换）。
- **大小**：解码后 ≤ 20 MiB（Q3）。说明：由模型逐字生成 base64 的实际上限远低于此；较大文件主要来自能读本机文件的编码类 Agent。

### 6.2 传输与暂存

- MCP 请求体当前上限 1 MiB（`continuity.ts:67` `MAX_JSON_BYTES`）。仅对 `tools/call` 且工具为 `clued_storage_submit`、带 `content_base64` 的请求，上限提高到 28 MiB；其他请求不变。
- 二进制**不进** Postgres 作业行，也不进 Queue 消息。建议暂存到新的 R2 bucket（Q3）：对象键为 `owner/connection/job`，内容用 AES-GCM 加密，AAD 绑定 `owner_id‖connection_id‖job_id‖content_sha256`，密钥与凭据 vault 分开。作业 `mutation` 只记录 `content_ref: {sha256, size, mime_type}`；request digest 覆盖 `content_ref`，不覆盖原始字节。
- 作业结算（committed / denied / cancelled）后删除暂存对象；bucket 设 24 小时生命周期兜底。uncertain 作业的暂存保留到恢复结算，恢复只做 GET，不重新上传。
- 迁移：`clued_storage_jobs_v2` 提交校验（`..._account_jobs_v2.sql:153` 的 `octet_length(content) > 1048576`）扩展为接受 `content_ref` 形态；文本形态不变。

### 6.3 执行与核验

- **effect**：≤ 5 MiB 用 multipart（现有 `create-effect.mjs:86-88`，Content-Type 改为请求的 `mime_type`）；> 5 MiB 用 resumable upload。session URI 只在内存中，不持久化、不记录。上传中断且无法在同一执行内确认时，作业进入 `uncertain`，按现有 `appProperties.clued_intent_id` GET 恢复，绝不开新 session 重传。
- 执行器在 effect 前从暂存取回内容并重算 sha256，不符返回 `STORAGE_CONTENT_STAGING_MISMATCH`，effect 为 0。
- **核验**（`kernel/host/resource-center-google-drive-postcondition.mjs:52-55, 98-113`）：`size`、`sha256` 改为取自 `content_ref`，不再从 UTF-8 文本计算；`mimeType` 须等于请求值（不转换）；Drive 尚未给出 `sha256Checksum` 时沿用现有轮询；最终 `sha256Checksum` 不等于 `content_ref.sha256` 时判为 `attention_required`。核验合同名升为 `clued.storage-create-verified/3`，旧作业仍按 `/2` 结算。
- 权限：二进制 create 与文本 create 同属 `create_file` 动作（Q2），不改写入策略摘要，不触发换策略。

## 7. 额度

### 7.1 建议默认值（Q7）

| 维度 | 计量对象 | 默认 | 硬上限 | Owner 可调范围 |
| --- | --- | --- | --- | --- |
| 读取交付字节 / 小时 | 每 Binding | 256 MiB | 2 GiB | 32 MiB – 2 GiB |
| provider 下载字节 / 小时（含 export、zip 解压输入、Office 部件） | 每 Binding | 512 MiB | 4 GiB | 随上一项 ×2 |
| 上传字节 / 小时 | 每 Binding | 256 MiB | 2 GiB | 32 MiB – 2 GiB |
| 账号合计（全部 Binding） | 每 owner | 1 GiB 读 / 1 GiB 上传 | 8 GiB | 32 MiB – 8 GiB |
| 单次读取 | 每调用 | 文本 256 KiB；二进制 8 MiB；图片 5 MiB | 同左 | 不可调 |
| 单个上传 | 每作业 | 20 MiB | 20 MiB | 不可调 |

### 7.2 计量

- 沿用 P2 做法（`20260930060000_storage_read_content_v1.sql:57-63`）：同一 Binding 的正文 admission 用事务级 advisory 锁串行；未结算的读取按**本次模式的单次上限**预占（文本 256 KiB，二进制 8 MiB），结算后按实际字节计。窗口为滚动 1 小时。
- 读回执新增 `delivered_bytes`、`provider_bytes`、`format`、`mode` 列；仍不记录正文、文件名或条目名（SFC §5.5）。
- 上传在 `submit` 时按 `content_ref.size` 记账，写在作业回执上；作业被拒或取消时不释放（防止靠提交失败的作业刷额度），这是保守选择。
- 超额返回 `budget_exhausted`，文案给出当前额度与“约 N 分钟后恢复”，不暴露其他 Binding 的用量。

### 7.3 Owner 可调

- 新表 `clued_private.storage_budgets_v1`：键 `(owner_id, connection_id)`，列 `read_bytes_per_hour`、`upload_bytes_per_hour`、`budget_generation`、Receipt；行不可变，改动 = 撤销旧行 + 插入新行（沿用 SFC §3.3 模式）。缺行时用默认值。
- 原生 RPC `clued_storage_budget_v1`（`status` / `set`，CAS `budget_generation`），只接受原生 Owner 会话，数值须在硬上限内。改额度不改写入策略、读取授权、`auth_generation`，也不影响排队作业。

## 8. 页面（`apps/clued-cloud/app/storage/connections/page.tsx`）

**现状**：每个连接有三个独立按钮：“查看目录结构”（`read`）、“读正文”（`read_content`，文案限定“仅 Clued 创建的文本文件”）、“改名和移动文件”（`modify`），见 `:131-199, 246-258`。

**改为**：

1. 顶部一个开关 **“正常使用”**。开启 = 读取授权 `{read, read_content}`，`content_profile = normal/1`；上传二进制随 `create_file` 自动可用（Q2）。原三个按钮移入“高级”折叠区，行为不变。
2. 点开关时：
   - 连接为 `normal` profile：弹出说明，确认后调用新原生 RPC `clued_storage_normal_use_v1`（`enable`，CAS `read_generation`，携带 `disclosure_version`）。
   - 连接为 `legacy` profile：弹出同一说明，确认后直接跳转 Google 同意页（`normal` 集合）。意图 `normal_use_requested` 与已确认的 `disclosure_version` 记在服务端 `prepare` 行里，不由浏览器回调参数决定。回调 `complete` 授予 `normal` 时，在**同一事务**内建立读取授权；授予 `legacy` 时只更新凭据，开关保持关闭并提示原因。
   - 对用户而言只有一次确认加一次 Google 同意。
3. 关闭开关：读取授权回到 `{read}`（仍可看目录结构，Q8），不改 token scope；另有“撤回全部文件读取授权”按钮执行 §2.4 第 5 项。
4. 新连接：连接表单上显示预先勾选的“正常使用”复选框与完整说明（Q1）；勾选则申请 `normal` 集合，并在激活事务里建立 `normal/1` 读取授权。
5. 额度：开关下方显示“每小时读取 / 上传额度”，提供 64 MiB / 256 MiB / 1 GiB 三档与自定义，调用 §7.3 RPC。

**数据**：`storage_read_access_v1`（`20260930010000_storage_read_access_v1.sql:14`）新增不可变列 `content_profile text not null default 'text/1' check (… in ('text/1','normal/1'))`。读判定器在 admission 中返回它；Worker 只有在 `content_profile = normal/1` **且** `provider_scope_profile = normal` 时才启用非文本格式和非 Clued 文件。已有 `read_content` 授权（按 `clued.storage-read-content-disclosure/1` 同意）**不自动升级**（Q10）。

**说明文案（`clued.storage-normal-use-disclosure/1`，实现 PR 可润色，改动即升版本）**：

> 开启后，你授权的 Agent 可以读取「Clued_资料中心」内的全部文件，包括你手动上传的文件：文本和文档的内容，PDF、Office、图片的原始内容，压缩包的目录和其中单个文件；视频和音频只读取时长、分辨率、大小等信息。Agent 还可以在该目录中新建图片、PDF、压缩包等文件（每个最多 20 MB），不会覆盖或删除已有文件。
> 读取到的内容会发送给该 Agent 所用的模型服务，已经返回的内容无法收回。
> Google 页面会显示“查看你 Google 云端硬盘中的所有文件”。Clued 服务端只允许访问所选目录，这个限制由 Clued 保证，不由 Google 保证。
> 默认每小时额度：读取 256 MB、上传 256 MB，可随时调整。关闭“正常使用”会立即停止 Agent 读正文和上传，但不会收回 Google 授权；如需收回，请使用“撤回全部文件读取授权”。

## 9. 威胁模型增量

在 SFC §7（T1–T15）之上：

| # | 威胁 | 场景 | 缓解 |
| --- | --- | --- | --- |
| N-T1 | 凭据或 Worker 失陷，暴露**整个 Drive 正文** | 原先只暴露元数据（SFC T3），现在可读全部文件 | vault AEAD 与 AAD 绑定不变；单一内容通道 + 已判定 ID 白名单 + URL builder（§3）；无通用 Drive 代理工具；成功升级后撤销旧 refresh token；降级路径（§2.4）；运行手册增加“批量 revoke 全部连接 token”应急步骤；Google 验证 / CASA |
| N-T2 | 二进制内容里的提示注入 | PDF 隐藏文字、图片内文字、Office 批注里写着指令 | 所有交付（含 image / resource 块）都带 `untrusted_content`；Agent 合同 T1 条款同样适用于二进制内容；destructive 约束不变 |
| N-T3 | 解析器 DoS / zip bomb | 高压缩比条目、巨大中央目录、深层 XML | §4 zip 限制（实际比率、累计解压、条目数）；禁外部实体；不递归；32 MiB 下载上限；超时即失败，不返回部分结果 |
| N-T4 | 敏感内容外流范围扩大 | 读取范围从 Clued 自建文件扩到根内全部文件 | 新说明文案与新 `disclosure_version`；已有授权不自动升级；按客户端 / 按等级 deny（D6）仍有效；额度；读回执 |
| N-T5 | TOCTOU 逃出根 | 父链校验后、下载前，文件被移出根 | 读后复核父链（§3 第 3 项）；不通过就丢弃字节 |
| N-T6 | 恶意上传 | Agent 写入可执行文件或伪装类型的多语言文件 | MIME 允许列表 + 魔数核对；拒绝可执行类型；不改共享设置；sha256 写后核验；`appProperties` 标记来源 |
| N-T7 | 成本与配额耗尽 | 大量二进制读取或上传 | 按 Binding 与按 owner 的额度；读写配额分开；上传按提交记账 |
| N-T8 | scope 混淆 | 部分授权、刷新后 scope 变化、出现 `drive` scope | 精确允许集合（§2.2）；刷新不得改变 profile；数据库 profile 与封存集合交叉核对 |
| N-T9 | provider 链接泄露 | `thumbnailLink`、导出 URL、resumable session URI 被带出 | 一律不进入响应、回执、日志（§3 第 4 项） |
| N-T10 | 暂存内容泄露或残留 | R2 暂存对象长期存在 | 独立密钥 AEAD；结算即删；24 小时生命周期；暂存对象键不含文件名 |

## 10. 分期

每期都是小 PR，迁移编号排在 P4 的 `20260930120000` 之后，具体时间戳由实现 PR 分配。

| 期 | 内容 | 迁移 | 测试 | 验收 |
| --- | --- | --- | --- | --- |
| **N1** scope 与任意文件读取 | §2 全部（scope 模块、profile 列、刷新规则、部分授权、重新同意、旧 token revoke）；§3 单一内容通道、读后复核；`content_profile` 列与 `clued_storage_normal_use_v1`；页面开关与说明（仅现有文本 / Google 文档格式）；新错误码 `scope_upgrade_required` | 连接行 `provider_scope_profile`；`storage_read_access_v1.content_profile`；OAuth `prepare` 增加 `normal_use_requested`、`disclosure_version`；`complete` 同事务建立读取授权；读判定器返回两列 | scope 矩阵（legacy / normal / 部分 / 含 `drive` / 刷新升级或降级）；重新同意失败旧凭据不变；`storage_root_busy`；刷新委托保持；R1–R9；CI 防漂移测试 | 真实账号：手动上传的 `.txt` 与 Google 文档可读；根外同类文件返回 `not_found_in_scope` 且无 media 请求；legacy 连接行为与今天一致；Google 验证状态记录在维护文档 |
| **N2** 格式 | §4 矩阵：PDF / 图片 / 缩略图、OOXML 文本提取、zip 列目录与条目读取、Sheets / Slides / 绘图 export、音视频元数据；§5 工具面；默认额度提高到 §7.1（固定值） | 读回执新增 `delivered_bytes`、`provider_bytes`、`format`、`mode`；admission 按模式预占 | 每种格式的正向夹具；zip bomb（比率、条目数、中央目录、Zip64、加密、未知方法）；XML 外部实体；超限各错误码；image / resource 响应形状与 base64 上限 | 真实 Drive：PDF、docx、xlsx、pptx、png、大图、zip、mp4 各读一次，结果与 §4 一致 |
| **N3** 二进制上传 | §6：`content_base64` 输入、请求体上限例外、R2 加密暂存、multipart / resumable、核验 `/3`、上传记账 | 提交校验接受 `content_ref`；核验合同 `/3`；作业回执记上传字节 | sha256 不符、魔数不符、禁用类型、20 MiB 边界、resumable 中断后 uncertain → GET 恢复不重传、暂存删除、判定拒绝时 effect 为 0 | 真实 Drive：上传 png、pdf、zip 各一，Drive `sha256Checksum` 与请求一致 |
| **N4** 额度与页面收尾 | §7.3 Owner 可调额度；页面额度控件；账号合计额度；“撤回全部文件读取授权”；新连接默认勾选；维护文档与 Agent 合同更新 | `storage_budgets_v1`；`clued_storage_budget_v1` | CAS、硬上限、改额度不影响策略与作业、账号合计跨 Binding | Owner 在页面一次开关完成开启；调额度后立即生效 |

N1–N4 全部完成、并经 Owner 真实验收后，才开工 P5 / P6 / P7。P4 按其自身合同推进。

## 11. 需要 Owner 决定的问题

| # | 问题 | 选项 | 建议 |
| --- | --- | --- | --- |
| Q1 | 新连接是否默认开启正常使用 | A：连接表单预先勾选，用户可取消；B：默认只开 `read`（沿用 D2） | **A**。符合“所有用户正常使用”，且仍是用户在说明文案前的显式操作 |
| Q2 | 二进制上传算哪个等级 | A：沿用 `create_file`；B：新增写入等级 `create_binary` | **A**。风险与文本 create 同类（只新建、不覆盖）；B 需要换策略，而 P3 的换策略会取消排队作业，与“一个开关”冲突 |
| Q3 | 上传上限与暂存 | A：20 MiB，R2 加密暂存；B：4 MiB，暂存在 Postgres 私有表 | **A**。避免把大字节放进作业行和 RPC；需新增 R2 binding |
| Q4 | PDF 是否做服务端文字提取 | A：N2 只给原始字节；B：同时用 WASM 解析器提取文字 | **A**。先看主要客户端能否消费 resource 块；不能时再单独立项做 B |
| Q5 | Office 默认行为 | A：默认文本提取，可选 raw；B：只给 raw | **A**。与 zip 读取器共用代码，所有客户端都能用 |
| Q6 | 超限图片 | A：尝试 Drive 缩略图降采样（N2 先实测 bearer token 能否取缩略图）；B：直接拒绝 | **A**；实测不可行时退回 B，并修订本合同 |
| Q7 | 额度默认值 | §7.1 所列数值 | 采用 §7.1 |
| Q8 | 关闭“正常使用”后保留什么 | A：保留 `{read}`；B：读取全部关闭 | **A**。与现有“停止读正文仍可看目录”一致 |
| Q9 | 面向其他用户的放行门槛 | A：Google 受限 scope 验证（含 CASA）通过后才对外开放，此前只给 Owner 与测试用户；B：以未验证状态开放 | **A** |
| Q10 | 已有 `read_content` 授权是否自动升级为 `normal/1` | A：不升级，须经新说明确认；B：自动升级 | **A**。说明内容变了，须重新同意 |
| Q11 | 升级成功后是否撤销旧 refresh token | A：撤销（尽力而为，写 Receipt）；B：保留 | **A**。减少 `legacy` 旧凭据的暴露面 |

## 12. 依据与核对定位

| 类别 | 文件与行号 |
| --- | --- |
| OAuth 与 scope | `apps/clued-cloud/worker/storage-google-oauth.ts:4, 90-162`；`storage-google-refresh.ts:4-6, 56, 73-89`；`storage-google-recovery-oauth.ts` |
| scope 完全相等校验 | `storage-cloud-executor.ts:12, 42`；`storage-cloud-recovery.ts:12, 79`；`storage-google-probe.ts:12, 83`；`storage-read-agent.ts:16, 218`；`kernel/host/resource-center-cloud-executor.mjs:16, 125` |
| scope 包含关系校验 | `kernel/host/resource-center-google-drive-create-effect.mjs:28-31`；`resource-center-google-drive-modify-effect.mjs:62-65`；`resource-center-google-drive-metadata.mjs:3-8` |
| 读路径 | `apps/clued-cloud/worker/storage-read-agent.ts:17-31`（常量与错误码），`:228-286`（根范围），`:288-383`（正文读取、export、Range） |
| 读取授权与正文额度 | `supabase/migrations/20260930010000_storage_read_access_v1.sql:14, 227, 309`；`20260930060000_storage_read_content_v1.sql:3-63` |
| 工具与响应 | `apps/clued-cloud/worker/storage-agent-tools.ts:22-24, 70-73`；`continuity.ts:67, 1512-1540, 1839-1860` |
| create 执行与核验 | `kernel/host/resource-center-google-drive-create-effect.mjs:48-91`；`resource-center-google-drive-postcondition.mjs:52-134`；`supabase/migrations/20260928070005_resource_center_account_jobs_v2.sql:153`；`20260928072813_resource_center_account_cloud_v2.sql:135` |
| 页面 | `apps/clued-cloud/app/storage/connections/page.tsx:13, 42-52, 131-199, 240-258` |
| 运维文档 | `docs/maintenance/resource-center-account-connection.md:84-117, 220-230, 473` |
| 上位合同 | `development/contracts/storage/StorageFullCapability.v0.1.md` §3–§9 |
