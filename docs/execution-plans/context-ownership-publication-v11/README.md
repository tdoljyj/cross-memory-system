# Clued Context Ownership / Publication v1.1 交付索引

日期：2026-09-07。状态：本地实现、限定验证及浏览器连接恢复完成；新能力未部署，完整线上消费者验收尚未完成。

用户关心的行为已实现为：开发连接先将过程保存到自己的受权Context；之后Dogfood User登录，只在Owner显式授予历史范围并关联项目后，使用独立User连接读取同一条记录及其版本。没有服务认证时只能形成明确标记的LOCAL_DRAFT；登录、安装Skill或同一邮箱不会自动导入本地草稿，也不会自动获得开发权限。

## 实现和证据

| 材料 | 用途 |
|---|---|
| [完整方案](Design-v1.1.md) | v1.1设计与37个验收场景 |
| [低成本执行计划](ExecutionPlan.md) | 37场景映射16个P0组；复用数据库、接口和独立审核 |
| [范围与发布边界](ScopeAndRelease.md) | 精确起点、后继范围、目标、待验事项及回退 |
| [适配合同](AdapterContract.md) | 新工具/RPC及Developer/User接线；尚未安装 |
| [浏览器验证](BrowserValidation.md) | 本地模式清空；生产Owner登录及浏览器操作恢复 |
| [独立范围审查](evidence/IndependentScopeReview.md) | 新能力与既有冻结对象边界 |
| [独立实现验收](evidence/IndependentValidation.md) | 实际独立执行、发现、修复及尚未通过范围 |
| [数据库结构化证据](evidence/DatabaseEvidence.json) / [运行日志](evidence/database-regression.log) | 合入上游搜索修复后的两种真实PostgreSQL基线 |
| [接口及旧回归](evidence/api-regression.log) | 新接口和原continuity关闭态回归20/20 |
| [构建清单](evidence/BuildManifest.json) / [构建](evidence/build.log) / [类型](evidence/typecheck.log) / [静态检查](evidence/lint.log) | 可核验构建结果及检查输出；空lint日志表示无诊断 |
| [源码清单](evidence/SourceManifest.json) | 最终文件摘要与迁移版本绑定；不哈希自身 |

## 已完成的验证

- 新数据库回归14/14，API及旧continuity回归20/20，独立脚本9/9；build/typecheck通过，定向lint无错误或警告。详细适用范围以对应报告为准，不能相加为原37场景全通过。
- 交付前远端从3064d77推进至793fb09。正常快进后，只对新增搜索迁移的共存影响补验：两种数据库profile均加载它，验证无Grant连接无法从默认搜索或历史搜索取得新私有正文。未重复未受影响的构建/页面测试。
- 补验首次在受限进程中因 `uv_os_get_passwd` 失败而未启动数据库，保留[失败日志](evidence/database-sandbox-start-failure.log)。以批准的宿主执行同一测试后14/14通过；不能把初次启动失败删除或描述为业务测试通过。
- 生产Owner真实登录及页面点击已核实；浏览器控制通过按任务身份选择实际浏览器、适当响应预算恢复。账号与密码无需重置。

## 尚未完成

1. 新迁移与Worker在正式目标的发布、能力启用及真实Owner→Grant/Link→独立Developer/User调用闭环；目前没有新生产Binding或新能力发布回执。
2. 实际AI Host隔离新会话验证H10，以及后继Skill受影响范围绑定和安装验证。网页清空和本地JWT fixture不能替代。

这些剩余项属于功能交付范围，未裁剪掉。下一步先完成可审查的实际连接/权限及后继消费者准备，再沿原通道执行迁移、部署、限定启用和双连接验收。无需重跑已完成的初代21步，也不创建额外付费环境。
