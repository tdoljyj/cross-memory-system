# RootSet Schema / URI 精确后继候选

**PROTOCOL_SUCCESSOR_CANDIDATE_NOT_APPLIED / NO_ROOT_OR_GATE_AUTHORITY**。这次把已获准限定登记所需编码具体化，不再保留URI/Schema空值。只对应原 S06 已有 `ControlTrustRootSet`，不新增核心对象、第二Auth、业务Receipt或Canon。

原源 S06 SHA256 `f967fdf3e63028d29ed191160698726b5d707aaae63bd951f6ba2e8584936fec`：L200字符串代际；L237动态对象分别核Schema/签名/代际/撤回；L868、4334、4336、4346指定core Schema、manifest URI模板与Control Evidence Store责任；L3010–3012四层epoch；L3885用途/Audience分离。原文没有给本具体URI字面量，以下URI与Audience是**本次限定后继新增的具体编码**，不声称是历史已冻结模板：

`urn:clued:control-trust-root-set:uscrdifznmlvczcekqpw:{root_set_id}`

仅允许 `ctr_414bd3c724264a83894b0c55cf2ab878`。`#history`读取完整events；`#revocations`读取同一一致快照内不可变撤回集合。解引用只经已有可信服务端transport执行 `select clued_control.read_root($1) value`；不是公开HTTP端点，也不暴露private schema到REST。错误项目/root/片段、缺历史、代际/正文序号不符或撤回/过期根拒绝；解引用返回 `UNVERIFIED_SOURCE_READ_ONLY`，绝不把service_role或本地形状检查当签名资格。

真实非生产存储已由主控部署并回读：`bootstrap/NonproductionControlStoreDeploymentSuccessor.json` SHA256 `58643a21e69cda0e06dbc70fc71724f75cd6bca930e17e6723287228e12daa99`，2026-09-08 12:02:29 UTC，目标 `uscrdifznmlvczcekqpw`，SQL `3cbbed94e1c9ef5fec4db281526ca69b9b30a24d2812b5a8bb5eb6bc728146fb`。三表均空、RLS开启、仅既有service_role两RPC执行，13张原public业务表metadata未变。**空store已部署；本Schema/URI后继与根实例尚未激活。** 本代理未重复数据库读取或写入。

`control-trust-root-set.schema.json` 的正式目标为原 `protocol/continuity/v1/schemas/core/control-trust-root-set.schema.json`。遵循现有 `$id=urn:clued:schema:…:v1`、draft2020-12、snake_case字段与显式object_type；限定project/root/profile/environment和零模型/付费预算。Schema覆盖独立的新代际+前代引用、Issuer用途/Audience、schema digest、算法/config、根自身历史/撤回来源、Owner/独评/签名绑定及有效窗。Issuer用途只具体化本范围的STATUS/GATE_AUTHORIZATION/GATE_RESULT，逐用途绑定资格和Audience，不开放Promotion；正式实例仍必须引用真实已接受的用途资格。

独评按原S06 L3008–3012确认：完整业务Vector必绑的枚举对象是Token、Session、BindingReceipt、Lease、RunnerCredential、LKG、CurrentnessReceipt、ExternalInvocationCapability、JobTaskEnvelope和下载/Secret Handle，未包括ControlTrustRootSet。已移除本候选额外强加的RootSet业务Vector，不填N/A或0；原Profile及实际凭据的四层职责不变，测试精确核对原Vector Schema SHA `c3c3c2ae05cd1f4f844f2f9898f1d29b2bfad2940975104847df41e1610831fe` 未改。实际非生产没有这些epoch字段不是新增虚构初态的理由，也不再成为首次控制根登记的自造前置。

`history.prefix_sequence/prefix_digest` 绑定登记前完整events前序，首次来自实际空Store的`[]`；不包含本RootSet事件，避免自摘要循环。解引用脚本实际取当前generation事件之前的全部events，核对序号和规范化摘要，不能只凭字段断言。`reviewSubjectDigest` 排除 `independent_acceptance_ref` 与 `signature_binding`，先供独评绑定；真实独评引用加入正文后，`signaturePayloadDigest` 只排除 `signature_binding`，由既有Owner签名来源绑定。两种摘要角色独立，改变独评引用不改变原审查subject，但必定改变签名payload摘要。排序JSON/UTF8/LF/禁止浮点的候选规范化沿已实现登记候选，实际算法/config接受引用仍是正式输入。SQL内部JSONB配置摘要与签名载荷摘要不混用。签名字段只引用既有签名来源，没有密钥或伪造签名字节；测试对象仅内存结构fixture，未签发、未写入Store，不把PR25对Owner批准的签名冒充覆盖fixture正文的签名。

精确未应用patch在 `ProtocolSuccessor.patch`，仅三个正式目标：新增一个原core Schema、增补现有Manifest、修订原 `scripts/verify-generated-artifacts.mjs` 对本特定后继的计数/精确映射检查。旧91/65集合只在本后继ID和完整mapping、scope、Schema摘要完全匹配时转为92/66；没有放宽未知后继或任意数量。Manifest只重算新Schema entry、受影响verifier entry及content_tree_digest。原requirements、trace、registered identifiers和32条规则没有改，原rule_set_digest/downstream_mapping_digest保持原值，检查实际核对其不变。新Schema完整摘要被新增guard绑定；改查询/改向生产/改URI字段/摘要或artifact数量均拒绝。

本后继改变Manifest内容，所以未来BOM或其他**引用旧Manifest完整摘要的受影响对象**必须使用实际新摘要重新绑定，不能继承旧对象的新范围PASS。没有倒写旧接受记录或重开原21步；没有声称本次执行了原G1、BOM、完整generated-artifacts、正式PQUAL、R11或Slice A。Schema级独评接受也不是root注册接受。原已冻结正式文件当前均未改；主控在独评后应用这个精确patch，再执行受影响正式集成检查与签名发布。

复现：`python -B build-successor.py` 只写本目录，先拒绝旧Manifest或已独评epoch Schema摘要漂移；`node --test successor.test.mjs`。既有Ajv6只用于该Schema所用draft07/2020-12共同断言子集，测试副本只改元Schema声明并去掉x注释，不声称支持完整2020引擎。校验器另外检查精确Schema摘要、Owner/撤回窗口和用途/Audience一致性。初次5通过/1失败是测试路径定位错误；修正后定点通过。此前7项属于未接受旧候选；按独评移除额外Vector要求、绑定真实前序及分开独评/签名摘要，并把control_root_successor完整对象纳入精确guard后，最终执行当前完整9项：**9/9 PASS、0skip、104.0257ms**。新增guard直接从生成验证器抽取其纯检查分支实测，无生产读取。最终 `git apply --check` 与候选脚本语法检查仅证明可应用/可解析，不代表已应用或正式资格。
