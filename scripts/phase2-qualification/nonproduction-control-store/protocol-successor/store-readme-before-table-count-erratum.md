# 非生产 Control Evidence Store 候选

**CANDIDATE_NOT_DEPLOYED / LOCAL_ENGINEERING_ONLY / NO_ROOT_OR_GATE_AUTHORITY**。

用户已批准限定登记例外；本候选实现原 S06 L868、4334/4336/4346 指定 Control Evidence Store 的非生产存储部分，目标仅既有 `clued-auth-test` / `uscrdifznmlvczcekqpw`、root `ctr_414bd3c724264a83894b0c55cf2ab878`。没有连接或部署 Supabase，没有修改既有14张业务表、生产、Auth、业务 Event/Receipt、旧pins或冻结 protocol 文件。

`install.candidate.sql` 是尚未部署的固定SQL候选，不是已生成正式迁移。部署调用必须在实际目标项目选择器已核对后设置 `clued_control.target_project=uscrdifznmlvczcekqpw`；该设置是误操作护栏，不是远端身份认证。`client.mjs` 接收现有可信服务端参数化SQL transport，不创建连接、加载密钥或暴露公开RPC；`project` 参数本身也不证明transport实际目标。主控应以工具的实际 project selector 与部署回读证明目标，不能只信调用者传入字符串。

新私有 schema `clued_control` 仅含三个表：`accepted_binding` 保存唯一限定root的已接受元数据；`events` 追加控制记录及撤回；`current_head` 保存同root串行CAS位置。所有表开启RLS，PUBLIC、anon、authenticated、service_role都没有表DML；只给既有service_role两个指定私有函数执行权。使用 SECURITY DEFINER 是为了让现有受信服务端经受约束函数执行事务而不获得表DML；所有函数空search_path、全部表显式限定schema。不新增身份角色、业务Canon或业务Receipt。参数检查与权限依据见 [Supabase函数官方文档](https://supabase.com/docs/guides/database/functions)。

安装**不插入accepted_binding或任何root实例**，也没有配置RPC。必须在真实独评、已接受Schema/URI映射、issuer用途/Audience、算法/config及签名来源齐备后，由主控另行发布精确单行配置INSERT；当前源码内只有实际Owner批准commit与候选subject的限定值，不能把测试里的SYNTHETIC字段用于配置。普通service_role仅表示存储写入信任边界，不是签发资格；SQL不验证OpenPGP、不替代既有GitHub签名验证或独立接受。注册事件body为已验证对象的存储载荷，本层不宣称验证其正式Schema或密码学有效性，外层接线前没有GA运行入口。

追加请求严格绑定root、原配置摘要、期望sequence、事件类型、代际、前代、幂等key与完整body。配置摘要使用Postgres JSONB文本的SHA256，仅是本适配器内部配置版本比较，不宣称S06跨语言正式规范化算法。行锁后再次核对Owner有效窗；同key同请求返回原event sequence和原request，不增加事件；同key变参冲突；不同key争用同sequence仅一个成功。代际只能继承当前且不能复用历史代际。generation/event与accepted binding不可更新、删除或清空。完整历史read是单条SQL的一致快照，没有分页省略。撤回不可恢复；本限定候选将当前generation撤回也关闭整个root，保守拒绝后继，未新增恢复授权。exact replay在撤回后只查询原证据，`authority_effect=NONE`；过期则连重放也拒绝。

管理员或既有高权限服务凭据持有人属于受信边界：此候选不防数据库owner禁用trigger/改函数或伪造配置，不把RLS描述为管理员隔离。没有建立第二Auth。当前性是数据库事务和点时读取，尚未接入GA副作用fencing；业务侧仍须真实授权、最新撤回及许可检查。首次序号只在新空配置后出现，所有写入均原子记录事件与current，不以Git工作树替代live存储。

`ProtocolMapping.candidate.json` 定点列出了原core schema责任域、当前缺失的真实Schema/URI、现有manifest应新增的单root映射以及精确SQL解引用。未臆造原文未给的URI字符串；该机器映射尚未应用，正式successor仍须生成实际schema、绑定模板和重算Manifest/下游摘要。这些是运行输入与接线缺项，不阻止当前存储实现，也无需重复申请已授予的限定实施权限。

实测命令：`node --test store.test.mjs`。使用已安装embedded-postgres/pg，在本机专用临时目录启动真实PG并在结束后停止清理；没有安装依赖、读凭据或连接外部服务。第一次7 PASS、2 FAIL（父项含失败）：测试预期trigger错误，但外键更早拒绝TRUNCATE；没有发生删除。将本地清空尝试加CASCADE以真正触发不可变护栏，并新增过期锁等待检查后，最终**10/10 PASS、0 SKIP，7960.619ms**（9个子项+1父项）。覆盖权限/空配置拒绝、双连接同key唯一、所有变参不改状态、不同key单CAS胜出、不可变与撤回、实际等待锁至Owner过期。测试配置是专用本地合成输入，不是已接受登记或正式issuer。既有表保护通过本地sentinel及SQL无旧表写引用验证，未声称复核了非生产14张真实业务表数据。

下一步只需独评本固定SQL/客户端/映射，然后主控按已授予范围部署空的非生产schema并回读权限/结构；真实根配置和登记须再绑定其具体已接受对象。当前不触发正式PQUAL、R11、Slice A或Health。

独评后继：旧SQL `74427d947d08c9502dfe33afcacd921e1ebe4efa7eed21859868ab3f55900fdf` 实证存在会话TimeZone引发配置摘要变化、JSON数值幂等key被隐式转为文本两处问题。现两个函数固定UTC，并要求幂等key的JSON类型为string；旧测试仅更新受影响的proconfig断言，不重跑旧10项。`node --test review-fixes.test.mjs` 实际本机PG **2个新增子项+1父项全部通过，0skip，3859.5627ms**：跨UTC/Asia/Shanghai读取摘要一致且合法跨连接追加/重放成功；numeric key拒绝且event/head不变、对应string key正常追加。旧10项只属于旧SQL，不能作为当前版本全量通过。独评复现来源是 `bootstrap/NonproductionControlStoreIndependentReproduction.json`；没有将合成配置变为正式接受。
