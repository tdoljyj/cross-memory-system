# Step 3：Library 与历史 Sites 缺口补证

## 已完成的历史 Sites 处置

**精确历史实例 `appgprj_6a8a7bff59548191b5250e5c28b8c80c` / `clued-cloud.tdoljyj.chatgpt.site` 可按 REMOVED 处置。** 这不表示所有 Sites 永久不存在。

证据链：

1. Git `920601a448a5ea8c99f99192cc2b3e59fd8a8843` 保全 ChatGPT Sites version 4 的 37 份源码；该提交原始 `.openai/hosting.json` 写出上述精确 project_id。
2. Git `414e6714c241443dda125811e512251dc3323388` 在 2026-08-24 的 Clued 日志 §26 完整记录用户要求删除、再次确认永久删除、目标仅为 Clued/clued-cloud、UI 明确返回“已永久删除 Clued”、列表复查为空，以及 URL/部署/版本历史被删除。这里只保全此次 26 行相关节与其原始 patch，不复制无关私人日志。
3. 本轮分别以原始 hosting 的精确 project_id 调用 `get_site` 与 `list_site_versions`，均返回结构化 `NOT_FOUND` / `404`。当前 404 单独不足以证明退役；它与前两项结合佐证这一个历史实例的删除。
4. 历史操作记录说明源码、Cloudflare Worker、正式域名、Supabase、DNS、Binding 数据不受当时删除影响。本轮没有操作这些资源，也没有重新删除、重建或部署站点。

机器来源：`sources/site-retirement.json`。其中 `evidence_refs` 引用 7 份证据，每份有相对路径、bytes 和 SHA-256，已逐份复核通过。删除记录是 Git 保存的当时操作日志；本报告没有声称找回了原始 UI 截图或新的删除 Receipt。

## Library 已推进但仍未完整

- 从精确候选 source binding 与 validation closeout index 提取 **7 份有 Library file ID / Library ID / 路径绑定的历史副本登记**。
- 保存 Downloads 顶层 **79 个 Clued 相关文件**的名称、大小与修改时间，未读其正文；这些本地下载不能代表 Library 全集。
- 核对精确 v0.2.7.1 候选 ZIP 的 **60 份以来源、交付、输入、清单、Registry、Inventory、Index 命名的 JSON 元数据**；未找到额外 `library_file_id` 或 `library_path` 字段，也没有发现 Library 完整分页导出。ZIP 的 960 成员清单只覆盖这一候选包，不能替代整个 Library 的命名表面。
- 对 Downloads、当前 work 和 Documents/Codex 做文件名层面的 Library/目录/元数据导出检索；没有发现具备全集/分页证明的 Clued Library 导出。该结果是限定搜索范围下未发现，不是声称全机或云端不存在。
- 本轮只做一次新的页面连接：浏览器清单成功，但对刚取得的 Chrome/ChatGPT 标签页连接约 20 秒后超时并重置。随后转文件/API路线。收到主代理关于本轮 Computer Use 因无法可靠确定浏览器 URL 而停止的政策消息后，没有再操作 UI，也没有换 UI 路线绕过限制。

机器来源：`sources/library-partial-metadata.json`。记录 source JSON pointer、历史 ID、路径以及有来源支持的内容大小/哈希；Library 本身的实时大小、时间和分页仍为未知，不能拿本地 mtime 冒充 Library 更新时间。

**Library 保持 `PARTIAL_KNOWN_REFERENCES_LIVE_LIST_UNAVAILABLE`，`closure_allowed=false`。** 不把它改成 SCANNED、N/A、空库或已封存。继续取得完整、按当前账号/目录范围分页的只读元数据清单，或有同等覆盖声明的既有元数据导出，才具备全量验收输入。

## 执行与证据范围

独立运行原 `sync-memory.ps1 -AlignAndVerify -Access PROJECT`：宿主最终成功，repository snapshot / read-only mirror / doctor 均 PASS，remote main 为 `507c69b8f0638ff9202a4eeb140c606f9089e821`，local feature 为 `f6bee6e01b05a65e0548af38b05e144814e6aa53`，关系 local-ahead。snapshot freshness 为 historical，未拿它认证当前 Phase 2 进度。简要事实保存在 `evidence/local-verification-summary.json`；不是可跨请求复用的 Context。

初始运行分别遇到 Python 解析、非仓库工作目录和受限执行中的 Git 连接问题，随后通过本轮允许的宿主流程解决；没有修改永久 PATH、代理、TLS、DNS 或 Git 全局信任配置。生成历史 Git 证据时仅对这个已知仓库使用单命令 `safe.directory`，未改全局配置。

本子任务只在 `work/step3-gap-library-sites/` 写入证据和结论，不改仓库、不提交，也不改用户的固定 21 步基线。
