# Step 3 Supabase 缺口补证

## 已完成的 schema 补证

独立遵守仓库 AGENTS.md 执行一次 `AlignAndVerify -Access PROJECT`：ALL PASS。远端 main `507c69b8f0638ff9202a4eeb140c606f9089e821`，受审工作分支 `f6bee6e01b05a65e0548af38b05e144814e6aa53`，分类 Local Ahead。历史 memory snapshot 未作当前 Supabase 状态依据。

既有测试项目 `clued-restore-8b1 / gfnfxbphsdtayoaxitly` 的初始 live 状态 INACTIVE；组织 live plan=free。现存 8B-1 报告确认它是已暂停的 US$0/月隔离恢复测试项目，但报告没有完整 schema 身份集合，故不能以此代替当前盘点。先向父代理提交具体成本及必要性证据，父代理复核通过后，仅恢复此既有项目，未新建、升级或启用付费 add-on。预期新增服务费用 US$0；未获取最终账单，不把估计写成实际结算金额。

Restore API 返回 success。等待到 **ACTIVE_HEALTHY** 后才采正式目录；RESTORING 中途的探针不作为正式来源。正式只读 SQL 返回 **1156 个唯一命名身份**：11 schema、51 relation、560 column、112 function（仅身份参数）、211 constraint、159 index、18 policy、5 trigger、29 role。没有查询业务正文、密码、令牌或凭据值，没有运行 DDL/DML、迁移或 Canonical 业务写入。

正式来源为 `restore-catalog.json`，包含旧格式外层 source/recorded_at_utc 与 `data.project_id/pages/pagination`，每页保留 query/rows/project_id。8 页分别 150×7+106；每条 total_count=1156，身份五元组无重复。采集后 DB 独立重算 count=distinct_count=1156，并返回排序身份集合 MD5 `baf4cca7964126f09df2329a2c56f55c`；本机独立重算一致（只作一致性校验，不作签名）。本机还计算同集合 SHA256 `9d989f25f67b784de97f07f8541159b5c4e5076f70262b229b4b8e01b4f0dcde`。

`restore-catalog.json`：294314 bytes，SHA256 `1b7bad2eb7aba024249cf70727d3984faa564c3e3b2b2f9e0bf88c5430e47e8c`。验证结果在 `restore-catalog-verification.json`，8 个原始 MCP 响应在 `raw/page-0.json` 至 `raw/page-7.json`。这是非原子采集窗口的语义快照，DB 最终身份集合核对增加完整性证据；不宣称源端永不变化或具有签名认证。

首次查询写成 `NOT LIKE 'pg_%'` 会误排除 `pgbouncer`；落盘前自查修正为 `!~ '^pg_'`，全部 8 页重新采集，增加该 schema 与 1 个函数。本次唯一正式来源是修正版 1156，未用首次 1154 结果冒充完整。

已发出 Pause，API 返回 success；实际经历 PAUSING 后，最终 live get_project 已确认 **INACTIVE**，与原状态相同。`restore-lifecycle.json` 绑定 before INACTIVE、during ACTIVE_HEALTHY、after INACTIVE 及 restore/pause 实际响应，全部引用记录大小与 SHA256；`project-final.json` 保存最终实际工具响应。未把接受请求等同暂停完成。

## Auth Redirect 保留真实缺口

Supabase 官方 [Auth config 管理 API](https://supabase.com/docs/reference/api/v1-get-auth-service-config) 明确读取端点为 `GET /v1/projects/{ref}/config/auth`，需要 auth:read / auth_config_read。当前已连接 Supabase MCP 工具集合没有此读取方法。本机宿主/沙盒 PATH 无 Supabase CLI，`npx --no-install supabase --help` 也确认没有现成缓存；未安装或新登录工具，未搜索、提取或输出凭据。

浏览器只读打开生产项目 URL Configuration 时可见正确目标 URL 和页面标题，但配置字段尚未返回；其后连接超时、Debugger unattached，按文档尝试恢复同浏览器会话仍失败。父代理随后通知其独立 UI 工具无法可靠确认浏览器 URL 并已安全停止，因此本子任务没有继续 UI 输入或更换技术绕过。

**NSI-GAP-AUTH 保持 UNKNOWN。** 本地 `supabase/config.toml` 的默认 Site URL/redirect 不是管理端真实值，不能用于补齐；亦未查询 auth 用户/OAuth 业务行反推配置。恢复项目 schema 的完成不使 Auth Redirect 自动通过。

## 交付与边界

父代理可以将已验证的 `restore-catalog.json`、raw 页、哈希验证及操作前后状态纳入 supplemental source，只解除它们实际覆盖的 restore schema 缺口。生产 Auth Redirect 仍需可用的已授权管理读取路径或正常浏览器会话。没有修改公共代码、没有 commit/push，没有替代任何正式 Architecture Acceptance/Freeze。

资料依据：[Project Pausing](https://supabase.com/docs/guides/platform/free-project-pausing)、[Upgrading / Pause and restore](https://supabase.com/docs/guides/platform/upgrading)。
