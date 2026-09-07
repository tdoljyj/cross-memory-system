# Step15/18：最低成本必经发布边界评估

**结论：Pro 不是原验收的必选条件。保留一个可执行的免费候选，但当前不签 Step18 PASS。** 它是“现有正式消费/发布入口 + 精确 Actions 制品回执 + GitHub 签名的发布声明”。当前最关键的缺口是：尚未证明哪一个现有入口真正决定 Phase2 Registry/Manifest 的正式消费，并强制拒绝绕过输入。

本评估只读，复用已有 403 与当前权限证据；未创建 PR、合并、推送、签名密钥、生产变更或新服务。精确来源及摘要见同目录 Decision.json。工作树基点为 40fea9e，来源按逐文件字节绑定，不能把并行新增文件全称为该提交内容。

## 为什么当前证据还不够

- 当前私库只有 tdoljyj 管理员，没有普通写入者；这是权限范围事实，不是“不可绕过”空集 PASS。未来任何 write 角色授权都使本次结论失效，不能将其改称管理员例外。
- naming workflow:184–188 使用 `if: always()` 上传诊断；validation workflow:182、195–204 又允许负例 harness 成功而被测 Gate 按预期失败。因此有 artifact、run 成功都不能单独表示正向合格。
- gate-receipt.mjs:23–34 按 check 名选取，:69–70 明确不授权 merge/deploy。还缺 workflow/verifier 身份与正式消费者的必经接线。
- two-level-snapshot.mjs:1033–1079 已有校验、CAS、原子指针和回滚；但它管理 memory snapshot，不能凭函数存在就说 Phase2 Registry 已受控。当前 Step7 generator:182–209 也明确只是生成派生文件，未激活运行时消费者。

## 唯一保留的候选

1. 沿用现有 Actions，只让**明确正向 required-check 集合**产生可晋升的发布对象；失败诊断照常保留。绑定 repo、候选 commit、可信 workflow/verifier/policy 字节、run/attempt、subject、Registry/Manifest、前序接受/冻结、artifact ID/digest 与真实 Gate 结果。不能只检查名字或 run conclusion。
2. 把该发布声明放入 GitHub 服务端生成并实际验证成功的 merge commit 的 tree。读取实际 `verification`，要求 verified=true、reason=valid、signature/payload 非空，并核对签名 tree 中声明字节及其 artifact/receipt 摘要；保全 merge actor、PR、commit/tree/blob 与验证结果。
3. **候选 CI commit 和签名声明 merge commit 是两个对象。** 发布经过原 CI 验证的精确 artifact，不能把前者 PASS 套给后者所有新文件。若受管 payload 改变，必须新候选/新运行；只补签名声明不能伪造新 tree 的回归结果。
4. 在实际决定正式消费/激活的现有入口强制验绑定。若使用旧 snapshot publisher，必须证明它确实接管本轮正式目标；若目标仍由别的消费者直接读取，那个入口也必须拒绝未合格输入。候选自己不能同时控制可信 verifier/policy 与被检内容。
5. 执行该**真实入口**的正向与错 subject、换 Manifest、旧 receipt、其他候选 PASS、改 workflow、签名/tree 不匹配等负例；再用现有低权限身份取得对选定发布目标的真实平台写拒绝。保全管理员实际例外的身份、动作、ref、时间和结果。仅离线 wrapper 测试不等于平台边界成立。

GitHub 官方确认 web interface 提交可由 GitHub GPG 签名，提供 web-flow 公钥；REST 提供实际签名验证字段。因此“签名 tree 内精确绑定发布声明”的路径有依据，可作为签名 attestation 候选。**不能预断每次 REST merge 一定签名，更不能把签名当成测试通过。** [GitHub 签名说明](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification)、[Commit verification API](https://docs.github.com/en/rest/commits/commits)。

## 对原 F-MAJ-004 四条件的处理

| 原条件 | 本候选如何处理 |
|---|---|
| 冻结 exact required check set | 保留明确合同与后续实际执行证明；不能用任意“四绿”代替。 |
| branch/rules protection 或等价外部不可变 Gate Receipt | v4 artifact 可承载平台不可变对象；必须核对 ID/digest/run 及真实 receipt。对象不可变不等于不可删除或永久保留；依赖在线对象时，过期/删除必须拒绝，或以保全的签名字节提供可独立验证证据。 |
| 签名 tag / attestation / 透明签名制品 | 上述实际验签的 merge tree 发布声明可作为候选。SHA 或 artifact 不可变性本身不是签名。 |
| 清理 merged duplicate branch with receipt | 合并之后对实际重复分支单独执行并记录；本评估未删除，也未豁免。 |

v4 immutability 与 REST 元数据能力由 [upload-artifact 官方说明](https://github.com/actions/upload-artifact)和 [Artifacts API](https://docs.github.com/en/rest/actions/artifacts)支持。GitHub 私库原生 artifact attestations 当前需要 Enterprise Cloud，但本候选不依赖该产品。[原生 attestations 可用范围](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)。

原 28 条由父任务逐项映射；本报告没有重解释原文为已执行，也不把 Step18 全部实跑证明倒灌为前序步骤阻塞。

## 有限停止条件

父任务后续提出把 `development/authority-index/phase2/SourceIndex.json` 接成正式治理入口。**这符合 TM-19 的原范围，前提是它仍为派生的权威引用索引，不自行产生批准权。** 原 `StructureCandidateMap.json` 的 TM-19（第 334、339–340 行，SHA256 `01a84a60d92611206466af4f54bf9c88bdc3173fff10d56ba13d22750b6a1965`）明确目标为 `development/authority-index/`，只指向已接受合同、Gate、Receipt。现有 publisher 命令只接收精确可信 CI、真实签名 tree 声明和已接受前序，再输出 activation 引用；正式读取也复验签名、subject 和当前接受引用。这是本候选的具体接线位置，不是新服务，也不触及 TM-07 Worker/Bindings。

该接线至少须真实拒绝：**stale**（旧签名有效但 subject/current 已变）、**wrong SHA**（候选/Manifest/制品摘要错）、**forged workflow**（修改可信检查或同名绿灯）、**skip**（跳过 publisher 后把普通 candidate 直接作为现行）、**bare pointer**（只有指针而无完整可信绑定）。加上现有低权限身份的实际平台写拒绝与管理员例外审计，才有机会证明当前限定边界；不是仅用零普通写入者作结论。授权回滚须另有事件，不能把旧签名直接重放为当前。父任务计划接线尚未执行，本报告只认可它与原范围兼容，不预先验收。

当前还差：**精确的正式消费/激活入口、实际签名发布声明、该入口真实拒错与低权限平台拒绝证据**。这些可以作为一次有界现有入口集成执行；“签名声明 + 权限检查”不能弥补一个仍可直接接受未验证 Registry 的入口。

若找不到可用现有入口，或必须新建服务才能隔离正式写入，就停止这个候选并保留 Step15/18 的具体 pending，不堆叠 wrapper。只有选择原生私库 Git 合并/写入保护路线时，才需要解决已经观察到的订阅可用性；本报告没有授权升级，也没有认定 Pro 是所有等价路线的前提。
