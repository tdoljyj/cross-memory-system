# 限定控制根登记候选与只读验证器

**CANDIDATE_NOT_REGISTERED / NO_GA_OR_QUALIFICATION**。用户已明确批准提案限定登记例外；本次依据新批准实施，不再以旧Owner L70一概拒绝。新批准仍要求独立接受、真实签名/存储/当前性来源，不能填假值完成登记。

批准原话“批准提案限定的登记例外”保存在 `artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/ControlRootRegistrationOwnerApproval.json`，SHA256 `3d9c4c9e06217c7c2ef0d32dba77bb5aa66bd745a8f92f0ea255b19a95127aea`；提案SHA256 `f655e8a16f428bbccfca3687c28e31bc57aed0e7a9fd9ac0191648266afec533`。准备时PR25候选提交为 `8b7ab53febf18c0be8084505d753190a7196fa28`，**没有把这个未确认merge的SHA记录为已验签**。

## 原责任域与候选身份

S06 SHA256 `f967fdf3e63028d29ed191160698726b5d707aaae63bd951f6ba2e8584936fec` L868、L925、L4334/4336/4346：`ControlTrustRootSet` Schema只属于 `protocol/continuity/v1/schemas/core/control-trust-root-set.schema.json`，URI模板属于 `protocol/continuity/v1/manifest.json#/control_uri_templates`；live控制实例由获准Control Evidence Store解引用，Git中的schema/工程证据不自动成为第二实例或业务Canon。当前对应正式运行实现未定位，**本目录仅候选格式/适配器代码，不向正式责任域写入重复权威**。

实际生成的候选在 `bootstrap/ControlRootRegistrationCandidate.json`：

- root_set_id：`ctr_414bd3c724264a83894b0c55cf2ab878`。
- generation_id：`ctrgen_352785779b64458a889d571360e2d2d5`。
- subject SHA256：`e4ab25ecb1fa6709435d0318ad431d14343482cbe84e232f638e55c3c4ba1e1f`。
- 序位1、前代null只表示**本次获准新建的首次登记候选**，不是捏造历史或当前合法代际。最终登记仍须完整限定域无前代证明；如已有登记，不得另起链绕过。

subject按候选编码“排序键、UTF-8、紧凑JSON、结尾LF、禁止浮点/重复键”固定摘要；只读验证器要求调用方提供独立接受的expected subject digest。`bindings`是后续实际签名/索引/存储引用，不参与subject摘要，避免把自身commit SHA写回自身而形成循环。候选不是原正式wire-schema实例，encoding须独立接受后才能用于此限定登记。

## 最小明确存储适配协议

拟适配的工程Evidence命名空间只有现有私库下：

`artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/runtime-evidence/control-root-registration/ctr_414bd3c724264a83894b0c55cf2ab878/`

该路径现在只是候选。不能凭PR25批准/普通commit就宣称正式RootSet已存入权威源。必须有真实独立接受的 `formal_store_binding_ref`，绑定同一subject、repository、namespace、`business_canonical_effect=NONE`、实际 `protocol_template_ref` 与 `schema_accepted_ref` 的路径/摘要。它的候选判定名为 `ACCEPTED_FOR_NONPRODUCTION_CONTROL_EVIDENCE_STORE_ADAPTER`，不代表该记录现在存在；缺失仍拒绝。若此后要在正式责任域增加适配实现，应提交该精确映射与读写边界，不能把本工程目录改名成Canonical Store。

候选格式的实际记录要求如下（**字段说明，不是已签发实例**）：

| 记录 | 最小字段与绑定 |
|---|---|
| 独立登记接受 | `state=ACCEPTED_FOR_LIMITED_CONTROL_ROOT_REGISTRATION`、既定`independent_reviewer`、exact `subject_sha256`、本验证器`verifier_sha256`；每代另绑定`root_set_id`和该代完整字节`generation_sha256` |
| Generation正文 | `root_set_id`、新`generation_id`、连续`generation_ordinal`、`predecessor`（首次null；后继含前代ID及其完整字节摘要）、`subject_sha256`、`not_before`、`expires_at`、`status=REGISTERED`。这些是将来真实登记后才可写的状态，不由测试创建 |
| `index.json` | 同一`namespace/root_set_id`、`as_of/expires_at`、`current_generation_id`、完整`generation_refs[]/revocation_refs[]`、当前Owner撤回状态。Generation ref包含path/sha256、真实publication_commit/PR和independent_review_ref；发布commit放后续index，避免自引用 |
| Revocation Event | 沿原不可变事件语义，候选编码含`status=REVOKED`、Owner authority、明确target_kind/target_id；未知状态/主体/目标均拒绝。它们全部由当前受信签名树绑定，不信任任意脱离签名的本地事件 |

首次Generation、独立接受与映射应先以真实Owner签名merge发布，再由后续签名index绑定其commit/摘要。验证器从首次发布第一父提交遍历所有可达parents，限定`control-root-registration/`域在每个历史tree都必须为空；只检查当前空tree无法排除“登记后删除”，不再接受这种推断。每个后继需独立接受、自身真实签名publication及publication到current head的祖先关系，不允许只凭最新Owner签名跳过独立评估。历史代际过期不删除历史；只有当前代际能满足当前有效窗。

## 验证与拒绝边界

`verify.py`仅GET现有GitHub API，不含写入、签发、隔离或GA入口。复用现有web-flow验证方法但不调用旧TM19验证器：检验Owner merged PR、相同私库/main、verified/valid、PGP载体、签名tree/双亲、内容SHA256/Git blob、批准→首次登记→当前main祖先关系。它依赖GitHub验证服务，不谎称本地OpenPGP验签。

当前性读取固定到实际main head，核对其Owner签名merge，递归tree未截断，命名空间内文件集合与generation+revocation index完全相等；结束时再读main，变化即拒绝。index摘要必须来自实际获准当前绑定，不能由不可信搜索结果替换。所有适用root/generation/Owner撤回阻断；撤回来源缺失/不明、Scope错误、过期、继承断裂/回退、旧代最低锚不在链中、引用缺失或离线均BLOCKED。

补充的历史完整性检查从current head沿全部父边遍历，直到前述已证实为空的祖先边界；每条父→子边中generation/event路径及blob/mode均须保留，只有`index.json`可更新。删除后恢复、先改后恢复、合并第二父分支上的删除也拒绝；当前tree/index一致不能替代这个检查。读取缓存最多256个完整commit，tree对象缺失/截断、不支持的链接或用尽预算均BLOCKED，绝不以局部历史宣布成功。这是候选读取资源上限，不是原合同历史长度上限；实际仓库若超限仍未核实，不擅自放宽。该逻辑未对真实完整注册历史执行；只读Git工程来源仍不自动成为live Control Evidence Store。

远端核验必须显式传`--minimum-generation-id`：首次用新候选ID，后续使用调用端真实已接受的最高代际，不能主动降回首次值。该工具不持久化反回退账本，也不解决同UID管理员篡改或跨副作用竞态；调用端尚未接线时只证明点时readback，不能据此开放GA运行。Owner对话撤回仍立即优先，不能等Git记录追加成功。

实跑命令：

```text
python -B -m unittest -v test_verify
python -B verify.py --candidate ../../../artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/ControlRootRegistrationCandidate.json --expected-subject-sha256 e4ab25ecb1fa6709435d0318ad431d14343482cbe84e232f638e55c3c4ba1e1f --shape-only
```

已实际执行7项本地合成逻辑检查并通过；覆盖缺真实绑定、范围扩张、签名/Owner/tree错误、过期、前代链/最低代际回退、撤回未知/已撤回、重复键/路径越界。后续新增祖先关系/完整tree读取检查，单独1项通过；不将7+1不同修订运行表述为一次完整8项重跑。合成签名字段仅用于解析拒绝逻辑，不是实际签名证据。候选shape只输出`CANDIDATE_SHAPE_VALID_NOT_REGISTERED`；真实入口实跑在联网前返回`BLOCKED: Missing actual binding: owner_approval_commit`（预期exit1），没有对远端链报告PASS。

独评指出的3项历史缺陷修复后，仅执行3个新增定点用例，3/3通过（2026-09-08，本地合成逻辑；实际输出0.001s）：每代publication祖先拒绝、全父历史无前代证明及读取预算/截断拒绝、event删除或改写后恢复及第二父分支删除拒绝。旧8项没有重跑，不把历史7+1与本轮3写成同一版本11项完整执行；合成对象不是真实签名或真实撤回来源。

PR25批准已于实际merge `4d7f93c17cf7d126e771cf8aca6299c868cba0a9` 签名落地；候选文件的`owner_approval_readback`保留2026-09-08T11:14:29–30Z定点API来源、批准精确内容摘要与当时验证器摘要，独立评审也已核对批准和提案。该观察只证明Owner批准来源，不能充当控制根登记接受。

当前仍待真实绑定：登记签名merge及独立接受；提案限定的**允许issuer用途与Audience**；适用正式Schema摘要；真实算法/config标识；实际Control Evidence Store的Schema与URI解引用映射；完整历史index与撤回事件来源。subject中的`purpose`不能替代这些全部元数据，候选编码也不是已接受的正式算法/config。主控已定位既有非生产Clued存储作为下一步适配候选；其精确接线仍须在原S06责任域审查，不能直接把工程Git目录激活成live Store，也不引入第二Auth、Receipt或业务Canon。本轮不实现或部署DB、不运行fencing。已有Owner授权足以继续完成这些具体候选和适配工作；没有将缺Schema格式当永久阻塞，也没有把未出现的真值造出来。无生产、私钥、旧pins修改、模型/付费或资格发行。
