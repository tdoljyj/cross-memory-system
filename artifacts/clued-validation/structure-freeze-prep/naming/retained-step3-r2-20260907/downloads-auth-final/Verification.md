# Downloads Auth 配置证据复核

结论：本轮在指定 Downloads 范围内没有找到可证明生产项目 `ccxsikzwxlolxqlosril` 当前 Site URL / Redirect URL 允许列表的管理端导出、配置操作回执或管理读取响应。`NSI-GAP-AUTH` 保持 **UNKNOWN**。本结论不是“生产配置不存在”，也不把本地开发默认值判为生产配置错误。

## 范围与方法

- 本次任务独立完成 `AlignAndVerify -Access PROJECT`，全部 PASS；远端 main `507c69b8f0638ff9202a4eeb140c606f9089e821`，本地 `f6bee6e01b05a65e0548af38b05e144814e6aa53`，Local Ahead。只作项目上下文定位，不将仓库历史快照用作 live Auth 依据。
- 只读递归列出 `C:/Users/Windows/Downloads` 中路径含 Clued、Supabase、Auth 或 cross-memory-system 的文件，保留 1549 条相关路径。
- 检索 1567 个文本条目，检查 13 个外层 ZIP 与 18 个不同内容的嵌套 ZIP，共 31 个 archive container。另有 14 个嵌套项已按 SHA256 去重；最终没有因深度或大小限制而遗漏的已发现嵌套 ZIP。
- 匹配 Auth 命名字段、管理配置路径、英文与中文回调术语；29 个来源出现匹配。命中来源原文件与 ZIP 外包的 SHA256 均在本轮自行重算，文本成员单独重算内容 SHA256，并记录成员链、行号及匹配行 SHA256。
- 保存字段名与剔除 query/fragment 的 URL，不保存相邻配置全文或凭据值。未查询业务正文、未扫描凭据库、未改变 Downloads、未调用 UI 或外部 API。

## 可复核发现

| 状态 | 来源与定位 | 所证明内容 | 不足以证明的内容 |
|---|---|---|---|
| VERIFIED（本地内容） | `C:/Users/Windows/Downloads/cross-memory-system/apps/clued-cloud/supabase/config.toml` 第 159、163 行 | `site_url` 为 `http://127.0.0.1:3000`；`additional_redirect_urls` 含 `https://127.0.0.1:3000`。这是本地开发配置。 | 生产管理端 Site URL 或完整 Redirect URL 允许列表。 |
| VERIFIED（本地代码） | `C:/Users/Windows/Downloads/cross-memory-system/apps/clued-cloud/app/page.tsx` 第 579 行 | 注册流程使用 `emailRedirectTo: window.location.origin`。 | Supabase 管理端已接受或已登记该来源；管理端实际保存的值。 |
| VERIFIED（本地代码） | 同项目 `app/oauth/consent/page.tsx` 第 58、59、92、97 行，以及 6 个构建 JS 条目，详见索引 | OAuth redirect 参数处理；部分构建文件包含生产项目 API 地址 `https://ccxsikzwxlolxqlosril.supabase.co`。 | Auth 配置管理响应或当前允许列表。 |
| DOCUMENTED（设计约束） | `Clued_Kernel_Next_多厂商连续性与执行基础设施完整整合方案_v3.3.md` 第 2245、2935、2937 行及早期版本/包内副本 | 出站策略和 OAuth 精确回调 URL 的设计要求。 | 任何已应用的具体生产 URL。 |
| DOCUMENTED（设计约束） | `Clued_手机端接入与公共插件发布决策备忘_v1.0.md` 第 109 行 | 要求将正式回调地址纳入允许列表。 | 具体回调值、配置完成回执或 live 状态。 |

关键原文件 SHA256（均为本轮自行重算）：

- `config.toml`：`2404878ff7dcbb8a4e42ed5a46ffeae13ce8350e7a31c1871dcb91ea1736c4a2`。
- `app/page.tsx`：`4dd4602eb8ac44d54de73e64876cf6381f1d832b16300937b11c050bc862a89e`。
- `SearchIndex.json`：`a23215c0fff496fd292841614559400c6539cddebd8442e91f7b1ab76b870743`。

## 局限与后续证据条件

文件检索排除了依赖、Git 元数据、memory/bundle/objects、备份及凭据存储目录；只检查相关路径的指定文本格式和 ZIP 中的文本元数据，不覆盖图片截图、PDF、Office 二进制文档或名称完全无关的文件。因此仅声明“在本轮明确检索范围内未找到”，不声明整个磁盘不存在证据。

要解除此缺口，仍需绑定生产项目 ID 和采集时间的已授权管理读取结果，至少包含 `site_url` 与完整允许列表，或可验证的配置回执并经过当前状态复核。客户端代码、开发默认配置、文件修改时间和设计要求都不能替代该证明。

既有恢复项目最终 `INACTIVE` 的结果没有重做或改判；本报告只处理 Auth 缺口。没有 Canon 业务状态写入、仓库公共代码修改、提交或推送。

证据索引：同目录 `SearchIndex.json`；可复现检索：同目录 `search-downloads.py`。索引保存全部相关路径、命中成员链、字段/URL 摘要和原文件 SHA256 引用，原件继续保留在 Downloads。
