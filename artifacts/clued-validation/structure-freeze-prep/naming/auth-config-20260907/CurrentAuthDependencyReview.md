# 当前生产 Auth 依赖与本次结构改造影响

审查对象：Git `5fad76df81c8a412e7768e08427841f0985a2588` 与 2026-09-07 08:38:32—08:39:00 UTC 的 Cloudflare 已授权只读响应。结论限于实现和部署依赖，不是登录全流程成功验收。

**当前生产仍使用 Supabase Auth；Site URL / Redirect URL 的实际配置值仍为 UNKNOWN。这个局部未知不是本次纯结构整理与命名盘点的通用 P0 前置。** 应继续不涉及认证地址的工作，只在某个具体改名、域名切换、回调迁移或 Auth 配置变更确实依赖这些值时，对受影响操作补证和验收。

## 证据与判断

| 状态 | 证据定位 | 结论 |
|---|---|---|
| VERIFIED | `current-auth-cloudflare-live.json`：域名列表与 deployment 响应均 200/success；域名 `clued.pixelgrav.com` 指向 `clued-cloud` production；active deployment `b7fb9087-0ce8-4b84-8c69-f0403b547c2c`，version `127811f4-997f-4815-b7ca-089dc387004c`，100% | 本轮明确定位生产 Worker，不将 Sites 或旧目录自动等同线上。 |
| VERIFIED | `current-auth-cloudflare-script-excerpts.json`：本轮 GET Worker script 200/success，正向命中 `/auth/v1/user`（offset 820007）、`signInWithPassword`（120905、851490）、`signUp` 的 `emailRedirectTo:window.location.origin`（121186）、`exchangeCodeForSession`（119062） | 读取到的 Worker 实现包含账户认证及回调处理。这不是只因数据库存在 auth schema 而推断。 |
| VERIFIED | 同响应：`authorization_servers` 指向 Supabase `/auth/v1`（837171）；`/oauth/consent` 路由及页面在 bundle 中；`clued_oauth_call`（830303） | 当前 MCP OAuth 使用 Supabase OAuth server。ChatGPT 可作为 OAuth 客户端；这不等于应用改用 ChatGPT Sites 的身份头登录。 |
| VERIFIED | Git `apps/clued-cloud/worker/continuity.ts` 第 485—495、524—535、897—908 行；部署脚本中对应正向片段 | 账户/Binding 管理校验 Supabase 用户；自定义 `clued_bnd_` 调用以 token hash 走 RPC，另有 OAuth token 通道。Binding 与账户认证并存，不能把已有 Binding 调用成功当作邮件回调配置已验收。 |
| VERIFIED | Git `apps/clued-cloud/worker/index.ts` 第 30—47 行先处理 continuity，随后交给 vinext app router；`app/page.tsx` 第 601、621—625 行；`app/oauth/consent/page.tsx` 第 44、52、76、90—97 行 | Next.js 风格 app 目录也用于当前 Worker 的 vinext 页面。不能把所有 app/Next.js 文件一概标成旧 Sites。 |
| VERIFIED（本地对象）/ 限定推断 | `app/chatgpt-auth.ts` 定义 `oai-authenticated-user-email`、`/signin-with-chatgpt` 辅助函数；Git 搜索除该文件自身外只有 README 使用说明；本轮 Worker body 未命中这两标记 | 仓库仍有 Sites 辅助代码，但没有把它作为当前登录实现的证据。当前 Supabase 依赖由上面的正向代码证据成立，不靠“未命中”推定线上 N/A。 |
| VERIFIED（版本化元数据） | 既有 `external-20260907/sources/supabase-catalog.json` 记录 auth schema；OAuth migration 第 27—28 行使用 `auth.uid()`、`auth.jwt()` | 数据库 Auth 对象及 JWT 身份参与后端授权。schema 存在本身既不能证明 Site URL 值，也不能单独证明某种登录页面正在运行。 |
| UNKNOWN | 未取得生产 Auth 管理配置读取响应 | 当前 `site_url` / 完整 redirect allowlist 具体值、是否与当前页面来源匹配，仍未验证。没有据此断言配置错误。 |

## Site URL 与 OAuth 回调的边界

普通邮箱密码登录在页面中直接调用 `signInWithPassword`；该调用没有配置回调 URL。注册明确传入当前 origin 作为 `emailRedirectTo`，页面同时接收 code/session 及 invite/recovery 返回。因此，Auth 服务依赖确实存在，但并非每次现有账户登录或每次 Binding RPC 都以 Site URL 取证为前置。

Supabase 官方文档说明 Site URL 是未传 redirectTo 时的默认去向，邮件确认、找回密码等回调与允许列表相关；同时明确区分“用户登录应用的 Redirect URLs”与“Supabase 作为 OAuth server 时第三方客户端的 redirect URIs”。不能把二者混成一个配置字段。来源：[Redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)。

对本次范围的处置：

- 仓库目录/文件整理、命名映射、引用校验、外部已有名称盘点：保留此字段 UNKNOWN，继续无关路径；不把缺取证自动升级为整个 Step 3 失败或 P0。
- 若某个操作会改变实际认证 origin、回调路径、OAuth client redirect URI、Supabase Auth 配置或替换认证链路：仅该操作需要针对相关配置补取当前值，并做受影响流程验收。
- 纯代码符号/文件移动如保持运行地址及协议不变，不因本未知项额外要求重做账户恢复或登录配置。

## 来源绑定与局限

部署注释为 `Clued PR8 log isolation bf0baaa`。该 Git 对象解析为 `bf0baaa785862b30f2c8331837d36a2dc692fb3d`；以上五个关键源码文件在该对象与 `5fad76d` 之间无 diff，其 blob ID 和本轮 SHA256 见同名 JSON。这增强源码关联，但部署注释不是构建签名或可复现构建证明。

Cloudflare 下载响应 body 在工具执行环境内计算 UTF-8 SHA256 为 `52918aa6b01a8418458d170b97fee33483002ddf686eb3ddf3a3fee143ad70cc`；它是工具返回字符串的摘要，不是原始 HTTP 字节摘要。本地只保存脱敏片段和结构化结果；没有独立重算完整远端 body，也没有保留完整 body。active deployment 与 script 读取不是原子快照，也未将 bundle 逐字节重建绑定到 Git。上述结论是当次部署定位与所读 Worker 的正向实现证据，不声称完整供应链证明或真实账户登录测试。

本请求独立 AlignAndVerify 全 PASS，remote main `507c69b8f0638ff9202a4eeb140c606f9089e821`、local `5fad76d`（Local Ahead）；canon snapshot 为 historical，未用于判断当前认证状态。未读密钥/业务数据，未恢复项目，未重试 UI，未改变外部配置，未写 Canon、提交或推送。
