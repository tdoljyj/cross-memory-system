# Context v1.1 薄适配合同（待后继安装）

适用范围：本次新增服务能力。本文为工程接线说明，未改已安装 Developer/User Skill，不赋角色或发布权限。

## 公共接口

- MCP：`clued_context`。服务开关启用才advertise。
- REST：`POST /v1/contexts`，Bearer为真实Binding Token或已有OAuth Binding对应的JWT。
- Owner：`POST /v1/contexts/owner`，仅普通Owner登录JWT，不能用Developer Token或委托OAuth替代。
- 实际RPC：`clued_context_call(p_token_hash,p_input)`、`clued_context_oauth_call(p_input)`、`clued_context_owner(p_input)`。调用方不传owner；服务器从已核验身份导出。
- 原始Binding Token只通过Authorization发往已绑定服务，Worker仅向数据库传SHA256；不写Skill、日志或仓库。

## Developer适配

1. 未登录Dogfood UI并不阻止Developer工作。先使用独立Developer Binding读取已获Grant的Context；没有认证只保留明确标记 `LOCAL_DRAFT` 的用户选择草稿。
2. `record_put` 写候选；`record_list`必须显式 `mode=development_history`。恢复状态、决定、失败与下一步时保留原ID/version、来源与freshness；UNKNOWN/STALE不称已核实当前。
3. 每次写使用稳定 `idempotency_key`，未确定结果重试同键/同内容，变更内容使用新操作；禁止把超时自动解释成未保存。
4. `accept`必须精确record_id/version/content_hash和publication_payload/environment/audience/channel；`publish`只建立待交付对象；`publication_deliver`以实际publication_id/base_version/expected_current核验交付。只有VERIFIED当前发布才可称指定渠道已交付。

## User适配

1. 安装Developer与User Skill不合并权限。User使用独立Binding；普通模式只 `context_list(mode=ordinary)` + `publication_read`。
2. 要读取过去开发历史，Owner须对这个User Binding签Grant（包含期望历史/版本范围且未过期），再 `link_upsert` 关联到已存在的用户项目；之后以User Binding显式读取development_history。
3. 只读历史授权不能record_put/accept/publish。个人批注在自己的User Context保存 `record_type=annotation`；`body.annotation_of` 精确绑定source context_id/record_id/version/content_hash。源授权受限时保留本人批注并显示source_access，不能复制源正文冒充当前。
4. 切换普通自测必须新建实际Host隔离上下文，丢弃开发package并使用独立User Binding。本服务和页面不会清除外部模型已有记忆；主机没有隔离能力时，不宣称H10通过。
5. 反馈只提交用户选定body与selected_evidence；不抓取项目/画像/会话。提交需独立feedback_submit权限，处理需feedback_manage；候选反馈不自动接受或发布。

## Grant与常见操作

Owner `grant_upsert`必传actions、history_policy、version_policy、expires_at；更新已有Grant还需grant_id/base_version。history_policy支持EXISTING_ONLY、EXISTING_AND_FUTURE、SINCE_CURSOR（since_cursor）、EXPLICIT_SET（explicit_record_ids）；FIXED_AT_GRANT由服务器捕获。write/accept/publish须获完整来源范围及LATEST，避免盲写或盲接受。

列表分页使用after_cursor/limit；反馈response为明确向提交者公开的JSON对象。普通读取失败要清除旧package，不能从历史回执重放正文来绕过已撤权。API/MCP领域payload不得被通用元数据脱敏改写。

## 当前消费能力边界

页面 `/contexts` 已有Owner项目/连接/授权选择、历史读取、候选保存、精确接受/两步交付、撤回和反馈提交。高级筛选、个人批注及反馈管理可走同一MCP/RPC合同；没有另建后台授权系统。网页不持久保存连接令牌；显示30秒到期、账号/模式切换、隐藏页面均清除会话结果。页面局部验证不是线上认证或外部AI Host验收。
