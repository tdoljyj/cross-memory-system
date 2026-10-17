# External Document Archive

KooYomi 的主代码仓库只保留与工程运行、构建、测试、协议、Schema、Migration、ADR、Runbook、Skill、当前执行控制和可复现机器证据直接绑定的内容。

产品研究、战略、商业、品牌、汇报、会议/对话整理、历史评审、验收长报告和 Closeout 叙事文档默认存放在 Google Drive，不再提交到主代码仓库。

## 2026-09-16 迁移

- 来源仓库：`tdoljyj/cross-memory-system`
- 归档源内容基线：`23ede3253cd89c3e378ba5811cba9c4844584fc7`
- 外迁文件：75 个历史叙事 Markdown 文档
- Google Drive 目录：<https://drive.google.com/drive/folders/1sKZEVQOsEGDMs2b18H3kHp7t0jGq0rGJ>
- 迁移索引：<https://docs.google.com/document/d/1RsQOrTyzBi9T5bbAI-PgDkVEPMJwkBpU2OAtmjxjJr0/edit?usp=drivesdk>
- 精确 ZIP：`cross-memory-system_externalized-docs_2026-09-16.zip`
- ZIP SHA-256：`d127c2289eb64fcc062a9e385272f8aca97441084e079968f2e827cbe08026c4`
- `MIGRATION_MANIFEST.tsv` 逐文件记录原仓库路径、字节数与 SHA-256。
- Drive 同时保存 `payload/` 原目录结构和原文件字节；索引文档用于浏览与核对。

## 当前计划与确定基线（2026-09-16）

- Google Drive 目录：<https://drive.google.com/drive/folders/1Owx0Ow4RQY0CbYB5aDQ8RMXLNTA6EyT0>
- 当前总索引：<https://drive.google.com/file/d/13TE41MmUMnMZ19imQlR5UtrIVEEaGDps/view?usp=drivesdk>
- 已按产品与体验、品牌与视觉、商业与增长、基础研究、治理与跨 Host、阶段计划与汇报、待补原始资产分类。
- 当前集合保存 52 个原始资料/报告/证据/待核验资产文件及 1 个总索引，共 53 个文件。
- MPS v0.1.2 精确包是 Owner-frozen Scope & Acceptance Baseline，完整 ZIP SHA-256 为 `d7c30f2060b0edd7ad51839f9edef0d1aa4c9b56fa6f1d66d33e56b6aa816a6e`；NON-PRODUCTION MPS Implementation v0.1 已获授权，但 69/69 Runtime Acceptance、完整证据包与 fresh-context 独立终审仍是必需门禁，不得写成 Runtime PASS 或 Production Approval。
- 已补入 GIKAO v0.1.2 完整 replay + final review 证据包；必须把 replay PASS 与最终 HOLD / FAIL 结论一起读取。
- `IMG_0499.jpeg`—`IMG_0504.jpeg` 经逐张核验属于 `Visual Territory C5` 多套调色探索，已放入 `90_待补原始资产` 并标记为 `UNBOUND CANDIDATE / NOT CURRENT / NOT FROZEN / NOT LOGO`；它们未与 `02.4B-R1 / Periwinkle B — Structure Growth / Growing Archive` 做 exact-byte 绑定。
- 文件存在于 Drive 不自行产生当前性或 Authority；以总索引状态、Canonical Decision/Event/Receipt 和 Owner 裁决为准。
- Google Drive 目录保持 Owner-only；没有明确人员、群组或链接范围时，不推断共享对象，不开放权限。

## 放置规则

应保留在 Git：代码、协议/合同、ADR、架构基线、Schema/Migration、测试/Fixture、Runbook、Skill、构建/部署配置、当前执行控制、机器可验证 Evidence。

应放 Google Drive：研究稿、战略/商业/品牌方案、汇报稿、会议或聊天整理、历史审查/验收/Closeout 长报告，以及不影响构建、测试、运行或维护正确性的叙事材料。

若文档同时包含工程合同与历史叙事，优先把可执行合同拆为仓库内的短工程文档，把长篇历史说明放 Drive。