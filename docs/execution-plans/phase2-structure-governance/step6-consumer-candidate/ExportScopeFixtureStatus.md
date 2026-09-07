# Canonical Export scope 隔离定位

状态：**SOURCE_MISMATCH_CANDIDATE / SQL_FIXTURE_NOT_EXECUTED / PATCH_NOT_APPLIED**。

精确来源：9bc1e7f 的 Worker continuity.ts:806—807 声明 context:read + audit:read；20260825171129_clued_m1_runtime_contracts.sql:703—709 的 Binding export wrapper 只检查 context:read/global。resolve_binding 在202608230002_mandatory_continuity.sql:95—129只检查传入的单一scope、context和revoked_at。原m1 SQL验收:99调用user wrapper，不覆盖这个Binding缺scope负例。

本轮只作一次可复用环境检查：当前repo、Downloads旧app和bundled runtime的embedded-postgres/pg均不可用；psql不可用；Docker可执行文件存在，但当前调用无法连接docker_engine（named pipe不存在），同时报告config访问受限。没有重试Docker、安装组件、启动服务或重建环境。因此没有真实SQL结果，也不把源码差异说成已证明的线上越权。

`export-scope-fixture.sql` 是基于现有M1 SQL fixture模式的最小新增草案：一个合成用户，五个合成Binding，仅测双scope正例、缺audit、缺read、已撤销、错误context负例。它要求数据库名以clued_scope_fixture_开头且连接本地，使用完整既有迁移；在事务中运行并回滚，只输出case/expected/actual/sqlstate/receipt布尔值，不输出snapshot正文。这里没有创建真实用户、生成用户JWT或查询生产数据。

`export-scope-forward-migration.DRAFT.sql` 仅增加与公开声明一致的audit:read检查，保持签名/grants/user wrapper不变。它尚未进入仓库、未应用、未验证SQL执行。收紧已有运行权限可能影响只有context:read的既有客户端，正式采用前必须先确认接受合同及受影响调用者，不能冒充纯文件改名的零语义差异。

若后续已有隔离Postgres可用：先在未修订源码的完整迁移上执行一次fixture并保存脱敏结果；预期缺audit案例可能显示committed，从而触发测试失败。再按已接受权限合同决定是否应用草案并执行一次同fixture。若实际返回结构与草案假定的receipt.status不符，应先依真实合同调整断言，不能通过忽略状态把unknown改成PASS。

该局部未执行项不阻止其他Step6矩阵准备、无关结构迁移或Step16四个ZIP Gate；没有触发用户现场登录。
