# 固定运行配置与范围材料

这是非签发装配材料。运行配置、范围和控制绑定只引用实际已有输入或最终完整执行源清单，不引用未来资格决定、Status 或 runtime 接受，避免摘要循环。未绑定完整 SourceManifest 和最终十九项 Test/Gate 套件时，生成结果明确保持等待状态，不能用于签发。

`build.mjs` 在相邻固定位置读取主控八项输入定义、Profile 180、真实镜像观察、已经接受的 SQL 字节和最终 controller/Test 输入，生成四项范围定义、根引用历史观察和字段候选。它不访问网络或数据库，不生成 GA、代际或接受结论。

`HostScopeBindingsCandidate.json` 可与既有 `PreparedBindings.json` 组合交给材料装配器。候选 Git blob 地址只由本地精确字节计算；主控必须通过原发布流程落地并独立读回，才能作为实际引用。`authority_source_ref` 是主控实际控制根读回的原 canonicalDigest，不是本观察文件的摘要；每次实际准入仍需重新读取现行根。

`AssembledHostScopeCandidate.json` 已使用原字段 Schema 和三个限定晚绑定规则装配，保留所有未具备实际来源的字段为未解决项。`ArtifactReferencesCandidate.json` 在 GA 原 `{uri,sha256}` 引用之外保存对应路径与精确大小，不向原 GA Schema 塞入额外字段。Status 的完整原签名 payload 由主控生成，这里不会伪造其摘要或签名。

计划摘要绑定最终十九项 Test/Gate 套件全部字节。夹具摘要只在所有十九项 `fixture_artifact_ref` 都指向同一个固定文件时绑定该文件；生成器逐项检查路径、大小、摘要和完整 executor 身份。任何新增夹具需要前向范围审查。固定文件是动作原语，不代表十九项已经执行或 Skill 行为通过。

固定 Node 到 Python 环境含四个非空公开基础路径值，以及八个明确设空的 Windows 变量，避免 Node/libuv 自动补入宿主值；容器使用独立的五项已核镜像环境。真实业务凭据、模型和付费动作均不在此范围内。独立 runner、credential、session 代际仍由实际控制域产生和核验，本材料不分配代际。

最后实际冻结时需重新生成摘要，核对全部本地引用，并交独立接受者评审；中间生成结果不可当作接受对象。`definitions.test.mjs` 只检查元数据引用方向和范围一致性，不启动任何进程监督、Docker、Skill 或资格测试。
