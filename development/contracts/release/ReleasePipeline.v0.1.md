# 发布流水线 v0.1：合入 → 测试环境 → 一次授权晋升生产

状态：设计稿 r2。r1 经过一轮独立审核，发现 1 BLOCKER、6 MAJOR，本稿已逐条处理（见 §16）。Owner 已经定了环境模型（D1–D3，见 §13）。本文不授权任何生产、DNS、密钥、费用或环境改动。

KooYomi 任务：`6f34ac0d`（测试环境）、`a7637067`（拆出生产与晋升路径）、`2e89ce6e`（CD 流水线）。相关任务：`c86bec39`、`a88d55eb`（beamingface.com 域名）。排序依据 Decision `02e4374a` 第 6 项，目标依据 Decision `afec9be8`。

## 0. 结论

1. **两套环境**。
   - 今天的环境原地定为 **production**：Worker `clued-cloud`，Supabase `clued-prod` / `ccxsikzwxlolxqlosril`，以及现有域名。
   - 另建一套完全隔离的 **test**：Supabase 新项目 `beamingface-test`，Cloudflare 用一个单独的免费账号，地址是该账号下的 `*.workers.dev`。
   - 依据 Decision `67ba2f5f`（取代 `117da1d5`）和 Decision `87a4a26c`。
2. **合入 main 后自动发布到 test**，Owner 不用点任何东西，整个过程只用 test 账号的凭据。测试令牌在物理上碰不到生产。步骤：
   - 应用待执行的迁移；
   - 部署 Worker；
   - 冒烟测试；
   - 冒烟失败时自动回滚 Worker。
3. **晋升到生产只点一次**。确认页上是一个 bundle：`migration.production`（每个待执行的迁移文件）加上 `release.production`（这个提交）。批准后，发布机按顺序自动执行，不再询问：
   - 备份；
   - expand 迁移；
   - 部署；
   - 冒烟；
   - contract 迁移；
   - 失败则回滚 Worker。
4. **回滚**。
   - Worker：自动回滚到部署前记下的版本 ID。
   - 数据库：只向前走。expand 迁移在部署前执行，必须兼容上一版 Worker；contract 迁移只在新 Worker 冒烟通过后才执行。数据库真正的回退只能从迁移前的备份恢复，需要 Owner 另行授权。
5. **密钥从不经过 Agent**。
   - test 的运行密钥由一次性初始化作业在受信 runner 上随机生成，直接写入 test，不打印。
   - 生产凭据仍是发布机上 root 所有的文件。
   - Owner 只需要：建资源、设置三个密钥值、按一次批准。
6. **今晚的情况**（没有快速通道，只能直接改生产）以后改为：修复 PR 合入 → 约 10 分钟自动上 test 并通过冒烟 → Owner 点一次 → 自动上生产。

## 1. 现状（2026-10-31 只读核对）

- **生产发布走发布机**：一次性 systemd 单元 `clued-existing-release-once.service`，运行在 WSL Ubuntu 24.04 上，入口是 `apps/clued-cloud/scripts/existing-release-v3-host/payload/release/existing-release-entry-v1/v3-host/release-once.mjs`。
  - 由 Root 手动启动，每次消耗一个 `release.production` grant（`existing-stages.mjs:83-101`）。
  - 只做部署和 7 项验证。迁移、备份和回滚由本设计补上（Task `2e89ce6e`）。
  - 出错就停在 `BLOCKED_OR_UNCERTAIN_NO_RETRY`，不重试（`release-once.mjs:90`）。
  - 主机上已安装的是 v6，v7 等单独的决定（`b8d7f4cb`）。
- **迁移和备份**只存在于托管工作流 `.github/workflows/clued-cloud-production-release.yml` 的 `migrate` / `backup` 模式里。它在 `ubuntu-24.04` 上运行，属于 Runner Runbook §2.4 冻结的托管债务。
- **验证脚本**：所有发布后验证脚本都写死了生产域名。仓库里没有任何回滚机制。
- **测试环境**：没有。`clued-auth-test` 是 INACTIVE。
- **Supabase 组织** `mqpgmvkdjrhukwmzvrug`（免费）：
  - 2 个活跃项目：`clued-prod`、`clued-handover-qualification`；
  - `get_cost`：新项目 $0/月；branch $0.01344/小时，付费，不采用。
- **迁移账本**记到 `20261023035740`，之后有 9 个文件不在账本里。其中部分已经直接应用到生产，账本还没重新导出。

## 2. 环境模型

| 资源 | production | test（单独的 Cloudflare 免费账号） |
|---|---|---|
| Supabase | `clued-prod` `ccxsikzwxlolxqlosril` | `beamingface-test`（新建） |
| 主 Worker | `clued-cloud`，配置 `wrangler.production.jsonc` | `clued-cloud-test`，配置 `wrangler.test.jsonc`（PR-B） |
| PDF Worker | `clued-storage-pdf` | `clued-storage-pdf-test` |
| Connect | `clued-connect` | 第一期不部署（Task `2e89ce6e`） |
| KV / R2 / 队列 | 现有 | 测试账号下同名新建 |
| 地址 | `clued.pixelgrav.com`、`kooyumi.pixelgrav.com`、`kooyomi.com`；`beamingface.com` 待 `c86bec39` | `clued-cloud-test.<子域>.workers.dev` |
| OAuth issuer | 现有两个 | 上述 workers.dev origin，与生产互不接受对方的令牌 |
| 访问保护 | 现有 | 应用自身登录（Decision `01905a95`） |
| Google 存储连接 | 开 | 关，相关 flag 不设 |
| Cron | `* * * * *` | `*/5 * * * *` |

- **dev.beamingface.com**：Decision `c3338ad8` 让它先作为生产的网页别名。它是否保留，由 `a88d55eb` 另议，与本设计无关。
- **test 的数据库结构**：初始化时按账本 `rows` 的顺序重放生产历史：
  - `source` 文件按记录的 `transform` 还原；
  - `history-only/` 里的文本照原样执行；
  - 重放完再应用待执行的文件。
  - 账本已经保证每一行都能复现，所以 test 和生产的差别只会是“尚未晋升的迁移”。

## 3. 流水线总览

```
PR 合入 main
  │ 自动；只用 test 账号凭据；自托管受信 runner
  ▼
T1 构建 + 离线门（无凭据）
T2 迁移计划 + 兼容检查（读 test 库）
T3 test 迁移（expand → 记录版本 → 部署 → 冒烟 → contract）
T4 失败：回滚 test Worker，用上一提交自己的合同冒烟
  │ 成功：test 正在服务该提交
  ▼
晋升（Agent 或 Owner 发起；一次只能一个；只能晋升 test 正在服务的提交）
  │ 发布机服务读 test 公网地址冒烟 → 自己算待执行迁移和兼容结论 → 开一个 bundle 请求
  ▼ Owner 在确认页点一次
P1 备份（有迁移才做）→ P2 expand 迁移 → P3 记录生产版本 id → P4 部署 PDF / 主 / Connect
→ P5 现有 7 项验证 + 冒烟 → P6 contract 迁移
→ 任一步失败：P7 回滚生产 Worker（仅在 P6 之前），用上一提交的合同冒烟，写记录
```

## 4. 阶段 T：合入后自动发布到 test

- **触发**：`push` 到 `main`。
  - 并发组 `clued-cloud-cd-test`：后来的合入会取消还在排队的旧运行，但不取消已经开始部署的运行。
  - 只执行已合入 main 的代码，不响应 `pull_request`。
- **执行机**：`[self-hosted, Linux, X64, clued, trust-internal, cap-docker-linux]`，GitHub environment `clued-test`，仅限 main。
  - 按 Runbook §2.4，不回退到托管机：没有空闲 runner 就排队或明确失败。
- **构建与部署分成两个作业**：
  - T1 构建作业不拿任何凭据，产物交给部署作业；
  - 部署作业只运行锁定版本的 wrangler，部署已校验哈希的产物，`--no-bundle`，不运行仓库的 build 钩子。
  - 即便如此，test 令牌最多也只能改测试账号。
- **T2 待执行迁移**：
  - 取全部可迁移文件（`MIGRATABLE_FILENAME`），去掉账本行已覆盖的和 `repository_only` 列出的，再去掉 test `schema_migrations` 中已有同名记录的，余下的就是待执行列表。
  - 不再只看 `history_through` 之后的文件。一个时间戳早于最新已执行文件、却还没执行的文件，报 `pending_out_of_order`，并停下等人看。
  - 然后对这些文件运行 `release-migration-compat.mjs`，结果为 `blocked` 就停。
- **T3 应用迁移**：逻辑与现有 `migrate` 模式逐字相同——每个文件一个事务、COPY 送入、校验 md5、写账本行。
  - 这段逻辑抽成 `scripts/ci/clued-cd-apply-migrations.sh`，test 和发布机共用（PR-B）。
  - test 数据可以重建，T3 之前没有备份步骤（Task `6f34ac0d`）。
  - 顺序：expand 文件 → `wrangler deployments status --json` 记下版本 id → 部署 PDF、主 Worker（`--keep-vars`）→ `release-smoke.mjs --env test --origin <test origin>` → 冒烟通过后执行 contract 文件。
- **T4 失败处理**：冒烟失败时：
  - 回滚到记下的版本；
  - 用 `git show <上一提交>:protocol/agent/agent-contract.md` 生成合同文件，以 `--contract-file` 冒烟上一提交；
  - 作业判为失败，在 job summary 中写明原因；
  - expand 迁移不回退，§6 保证它们兼容上一版 Worker。
- **证据**：写在 runner 本地的 `evidence/test/<sha>.json`，不用 Actions artifact。晋升时不读这份证据，而是现场重新检查（§7）。
- **写 KooYomi**：第一期只写 job summary，第二期由 Binding 写 Event（`2e89ce6e` 验收 5）。

## 5. 冒烟测试（本 PR 已实现）

脚本 `apps/clued-cloud/scripts/release-smoke.mjs`，测试 `tests/release-smoke.test.mjs`。

- 只发 GET，`redirect: manual`，不读任何凭据。
- 每一轮检查：
  - `/healthz` 返回 200、`status=ok`，且 `source_commit` 等于预期提交（这个值在构建时写入，`vite.config.ts`）；
  - 首页返回 200；
  - `/clued-agent.md` 以合同原文开头，bootstrap 的版本、URL、sha256 都一致。
  - 合同默认取工作树里的版本，回滚后用 `--contract-file` 指定上一提交的合同。
- 默认最多 6 轮、间隔 10 s，等待新版本生效。
- production 有默认 origin，test 必须用 `--origin` 指定。evidence 里会记录 `origin_overridden`。
- 2026-10-31 对生产只读实跑，提交 `eaca4eab` 一轮通过。
- 局限：
  - 只检查主 Worker。生产上的 PDF 和 Connect 仍由现有 7 项验证覆盖。
  - 四个 GET 是分开发出的，部署切换的那几秒里可能看到新旧混合；靠多轮重试来收敛。

## 6. 迁移：顺序、兼容性、备份

**顺序**：按文件名时间戳升序执行。已有同名记录的文件拒绝重放。

**兼容性检查（本 PR 已实现）**：`apps/clued-cloud/scripts/release-migration-compat.mjs`。

- 预处理：去掉注释，把字符串（含 `E''` 和反斜杠转义）、带数字标签的 dollar-quote 函数体都替换成占位符，并处理带引号的标识符。
- 只检查**本文件之前就存在的对象**，找出会破坏上一版 Worker 的语句：
  - 删除 table / view / materialized view / schema / type / sequence / index；
  - 删列；
  - 改名或 set schema；
  - 改列类型；
  - set not null；
  - 打开 RLS；
  - 删除 policy（同名重建不算）；
  - 删除函数（本文件先建后删的临时函数不算）；
  - 按完整签名比较，先删后以同名重建、但签名不同，算签名变更（包括 overload 互换）；
  - 函数改名后没有用原名重建包装函数；
  - `cascade`。
- **不覆盖**：新增约束、唯一索引、权限收回、`EXECUTE` 里的动态 SQL、函数体内的语句。这些在 PR 审核时人工判断，确认页上会显示待执行文件清单。
- **结论**：
  - 所有文件都不含上述语句：`automatic`，可以自动回滚 Worker。
  - 文件**在第一条语句之前**有一整行注释 `-- clued-release: breaking <理由>`：归为 contract 文件，只在新 Worker 冒烟通过后执行（P6 / T3 末尾）。一旦执行，这次晋升就不再自动回滚 Worker（`until_contract_migrations`）。
  - 有上述语句但没有声明：`blocked`，流水线拒绝执行。
- 在 286 个历史文件上实测：标记 12 个，内容是删表、删 policy、删除或改名函数、收紧 not null。9 个待执行文件都没有被标记。
- 推荐写法：先 expand，等不再使用旧结构的 Worker 已经上线，再在后续版本中 contract，并加上声明。

**备份**：只要晋升带有迁移，就先执行 P1，P1 成功后才进入 P2；没有迁移的晋升不做备份（Task `2e89ce6e`）。

- 逻辑沿用 `backup` 模式：
  - 在容器里运行 pg_dump；
  - 用 `verify-production-backup-scope.mjs` 校验范围；
  - AES-256 加密；
  - 解密回读核对哈希；
  - 清除明文。
- 存放：发布机本地 `/var/lib/clued-production-release/backups/<sha>/`，root 所有，0700，保留最近 10 份。
- 第二副本（放到另一台自有节点）和发布机加固单元中的 Docker 可用性，在 PR-C 里定并实测（Task `2e89ce6e`）。

## 7. 晋升：一次授权

1. **发起**。
   - 在发布机所在的受信 runner 上 dispatch `clued-cloud-promote.yml`，参数只有 `commit`。这个作业不持有任何生产凭据。
   - 它只做两件事：把 commit 写入 `/run/clued-promote/request`（root 预建，runner 用户可写），然后 `systemctl start clued-production-promote.service`。
   - polkit 规则只允许启动**这一个非模板单元**。
   - 单元自带 `flock`，同一时间只有一次晋升；服务运行期间再触发，会直接退出。
2. **服务启动后**。服务以发布用户身份运行，凭据只来自 root 所有的文件。
   - 读出 commit，核对：
     - 它属于 `main`；
     - 它是当前生产 `/healthz` 中 `source_commit` 的后代（`merge-base --is-ancestor`），从而拒绝回退到旧提交；
     - test 正在服务该提交，并且冒烟通过（服务自己对 test 公网地址跑 `release-smoke`，不读任何上传的证据，不需要 GitHub 凭据）。
   - 由此可知，只能晋升 test 上最新、已经通过冒烟的那个提交。
   - 再读生产 `schema_migrations`，按 §4 的方法算出待执行文件，并跑兼容检查。
   - 若该 commit 已有一个正在等待的请求，就复用它，不新开（门本身也会复用，`20261004200000_owner_request_bundles.sql:110-118`）。
3. **一个链接**。
   - 有迁移时，复用现有 `clued-release-grant.mjs` 的顺序：主 action 是 `migration.production`（每个文件一个 resource），`with` 中是 `release.production`（commit）。bundle 机制把它们合成**一个确认链接**。
   - 没有迁移时，只有 `release.production`。
4. **Owner 点一次**。
   - 服务每 30 s 再调用一次门，最长等 60 分钟。超时就退出，什么都不改。
   - 门**只消耗主 action**（迁移文件第 134-137 行）。所以批准后服务依次调用门两次：先消耗 `migration.production`，再消耗 `release.production`。两个 grant 都来自同一次批准，每次消耗都留下 Receipt。
   - grant 绑定到具体的 commit 和文件。如果超时之后才批准，这个 grant 只对该 commit 和这些文件有效；同一提交再次发起时会把它用掉，这正是原意，不会落到别的提交上。
   - 如果 Owner 对这两个 action 开了自动批准规则，就按规则执行。
5. **批准后自动执行 P1 → P7**，不再询问。
   - 部署沿用发布机现有序列：队列只读 info，PDF、主 Worker、Connect 依次部署，然后 7 项验证。
   - 插入的步骤：P1 备份、P2 expand、P3 记录版本 id、P5 末尾加冒烟、P6 contract、P7 回滚。
   - 回滚只能回到 P3 记下的 id，不接受参数。它包含在本次 grant 内。

第二期（PR-D）：确认页显示“test 冒烟通过时间 / 迁移清单（expand / contract）/ Worker 回滚方式”。

## 8. 回滚

| 对象 | 何时 | 怎么做 | 授权 |
|---|---|---|---|
| test Worker | 冒烟失败 | 回滚到记下的 id；用上一提交的合同冒烟 | 无需 |
| 生产 Worker（主、PDF、Connect） | P4 或 P5 失败（P6 尚未执行） | 按 Connect → 主 → PDF 的逆序回滚到 P3 记下的 id；用上一提交的合同冒烟；写 Receipt | 包含在本次 grant 内 |
| 生产 Worker | P6 contract 迁移已执行后又出问题 | 不自动回滚，因为上一版 Worker 已不兼容。告警并写 KooYomi，默认向前修复 | 新一次晋升 |
| 生产数据库 | 迁移造成数据错误 | 不自动回退，默认用新迁移向前修复。万不得已时，从 P1 的加密备份恢复到**新建**项目，核对后再切换，会丢失备份之后写入的数据 | Owner 单独授权，单独 runbook |
| 迁移中途失败 | P2 / P6 | 失败文件的事务自动回滚。P2 失败则停止、不部署；P6 失败则保留已经通过冒烟的新 Worker（它与 expand 后的结构兼容）并告警 | 无需 |

**演练**（`2e89ce6e` 验收 3）：在 test 上部署一个 `/healthz` 返回错误提交的构建，必须观察到自动回滚、healthz 回到上一提交，并留下证据。演练通过后才对生产启用 P7。

## 9. 凭据与边界

- Agent 不读、不生成、不转交任何密钥。
- **GitHub environment `clued-test`**（仅限 main）中只有 Owner 设置的值：
  - `CLUED_TEST_CLOUDFLARE_TOKEN`：测试账号的 Workers Scripts、KV、R2、Queues 编辑；
  - `CLUED_TEST_CLOUDFLARE_ACCOUNT_ID`：测试账号 ID；
  - `CLUED_TEST_DATABASE_URL`：test 项目的迁移连接串。
- 测试账号没有生产 zone，令牌不需要也不会有任何 DNS 权限。
- **test 运行密钥**（存储 vault、issuer、gateway 等随机值）由工作流模式 `bootstrap` 生成：
  - 在受信 runner 上用 `openssl rand` 生成；
  - 直接经 `wrangler secret put` 写入，同时把数据库需要的哈希写入 test 库，全程不打印；
  - 它只能改动测试账号和测试库，所以不需要批准。Owner 只需设开关变量（§14 第 6 步）。
- **生产凭据**仍是发布机 `/etc/clued-production-release/secrets/` 下 root 所有的文件。新增两个：
  - `migration-database-url`
  - `production-backup-key`
- 生产凭据不进入普通测试池（§2.4）。runner 只能写入请求文件、启动一个固定单元，碰不到任何生产凭据。

## 10. 费用

依据 Decision `9eb313f8` / `325717a6`（能不花钱就不花）：

- **Supabase**：在免费组织里新建一个项目，`get_cost` 显示 $0/月。但已有 2 个活跃项目，创建时如果提示收费或要求暂停其他项目，就停下由 Owner 定（Decision `67ba2f5f`）。不使用 branch。
- **Cloudflare**：新开一个免费账号。Workers、KV、R2、Queues、cron 都在免费额度内；创建时请顺手看一眼有没有出现计费项。
- **GitHub**：只用自托管 runner，不用 artifact。
- **备份**：存在自有磁盘。

## 11. 与已有决定和任务的关系

- `117da1d5` 已被 `67ba2f5f` 取代。`a7637067` 验收第 6 条（“现有环境改名为测试”）需要按 `67ba2f5f` 修订。
- `c3338ad8`：apex `beamingface.com` 指向生产，不再需要“将来改指”。`dev.beamingface.com` 的去留归 `a88d55eb`。
- `2e89ce6e` 验收 6（“晋升门控在 `a7637067` 完成前不启用”）：test 建成后前提即满足。
- Runbook §2.4：所有新作业都跑在自托管机上。托管的 `clued-cloud-production-release.yml` 在晋升通道验收后，按“先替代、后停用”退出（PR-D）。

## 12. 实施分期

| 期 | 内容 | 受保护路径 | 外部前提 |
|---|---|---|---|
| PR-A（本 PR） | 本设计；`release-smoke.mjs`；`release-migration-compat.mjs`；单元测试 | 无 | 无 |
| PR-B | `wrangler.test.jsonc`；`clued-cloud-cd.yml`：构建与部署分开的 T1–T4 和 `bootstrap` 模式，以变量 `CLUED_TEST_ENV_READY=true` 开启；`scripts/ci/clued-cd-apply-migrations.sh`；待执行迁移计划器；test 账本重放；workflow 的 coverage / budget 登记；回滚演练 | `.github/**`、`scripts/ci/**` | Owner 动作 1–5 |
| PR-C | 发布机 v8 包，以 v7 为基线：晋升单元与 polkit、请求文件、flock、祖先与 test 冒烟核对、门等待与两次消耗、P1 备份、P2 / P6 迁移、P3 记录、P7 回滚、冒烟；`clued-cloud-promote.yml` | `.github/**`、`scripts/ci/**` | Owner 动作 7；按发布机既有流程安装一次 |
| PR-D | 确认页显示 test 证据；发布记录自动写 KooYomi；托管 deploy / migrate 模式退出 | 部分 | PR-C 验收 |

每一期都按 Decision `01d4ba7d`：只读检查 → 修改 → 独立审核 → 通过后归档。

## 13. Owner 已定事项（2026-11-01 弹窗）

- **D1** 今天的环境原地定为生产，另建 test：Decision `67ba2f5f`，取代 `117da1d5`。
- **D2** test 数据库在免费组织新建 `beamingface-test`：Decision `67ba2f5f`。
- **D3** test 用单独的免费 Cloudflare 账号，地址为 `*.workers.dev`：Decision `87a4a26c`。Owner 第一次按 r1 的推荐选了“同一账号”，独立审核发现阻塞问题后重新弹窗，改为本项。

## 14. Owner 动作清单

每一项都是一次创建或一次授权，由 Owner 本人完成，值不经过 Agent。

1. 在 Supabase 组织 `mqpgmvkdjrhukwmzvrug` 新建项目 `beamingface-test`，区域 `ap-northeast-2`。若提示收费，停下告知。
2. 在 Cloudflare 新建一个免费账号（同一登录下“添加账户”即可），开启 workers.dev 子域。
3. 在该账号下创建 API 令牌，权限为账号级 Workers Scripts、Workers KV、Workers R2、Queues 编辑。
4. 在 GitHub 新建 environment `clued-test`，部署分支只允许 `main`。
5. 在 `clued-test` 中设置三个值：`CLUED_TEST_CLOUDFLARE_TOKEN`（第 3 步的令牌）、`CLUED_TEST_CLOUDFLARE_ACCOUNT_ID`、`CLUED_TEST_DATABASE_URL`（第 1 步项目的 Postgres URI，密码需 URL 编码）。
6. （PR-B 合入后）运行一次 `bootstrap`，然后把仓库变量 `CLUED_TEST_ENV_READY` 设为 `true`。
7. （PR-C 合入后）在发布机按既有流程安装 v8 包（一次 UAC / root 操作），并放入 `migration-database-url` 和 `production-backup-key` 两个凭据文件。
8. 每次晋升：在确认页点一次。

## 15. 待核实与风险

- Supabase 免费活跃项目上限：创建时以页面提示为准。
- `wrangler rollback` 在 `--keep-vars` 和 custom domain 下的行为：PR-B 在 test 上演练。回滚只切换代码版本，不改 vars 和 secrets。
- test 账本重放：早期 `history-only` 迁移可能依赖生产特有的扩展或角色。PR-B 先演练，发现差异就登记到 `known_deviations`。
- 备份目前只有一份，且发布机加固单元能否使用 Docker 尚未确认：PR-C 实测（§6）。

## 16. r1 独立审核处理表

| # | 级别 | 问题 | 处理 |
|---|---|---|---|
| 1 | BLOCKER | 同一账号下，test 令牌可以绕过 Owner 改动生产 | Owner 改选单独账号（`87a4a26c`）；构建与部署分开；令牌没有 DNS 权限 |
| 2 | MAJOR | 门只消耗主 action，迁移 grant 不会被消耗 | §7.3–7.4：主 action 为迁移，批准后依次消耗两次 |
| 3 | MAJOR | contract 迁移在部署前执行，会破坏旧 Worker | contract 文件放到新 Worker 冒烟之后（P6） |
| 4 | MAJOR | 晋升并发，且可以回退到旧提交 | 单个固定单元加 flock；要求是生产提交的后代 |
| 5 | MAJOR | test 证据来源不可信，且依赖 artifact | 晋升时服务自己对 test 公网地址冒烟；不用 artifact |
| 6 | MAJOR | 兼容检查漏报（E-string、overload、改名、收紧等） | 重写预处理与规则，补齐对应测试；未覆盖的类别写明（§6） |
| 7 | MAJOR | 回滚后冒烟用了新提交的合同 | 增加 `--contract-file`，取上一提交的合同 |
| 8–9 | MINOR | 声明标记过松；dollar 标签不支持数字 | 声明只认首条语句之前的整行注释；标签支持数字 |
| 10 | MINOR | 冒烟覆盖不足 | 局限写入 §5；生产仍跑 7 项验证 |
| 11 | MINOR | 待执行迁移列表可能出错 | §4 改为全量比对，乱序文件报错停下 |
| 12 | MINOR | 文中数字错误；bootstrap 的批准说法不清 | 已更正 |
| 13 | MINOR | 触发器可被滥用；批准晚到 | 单个单元、复用等待中的请求；grant 只对指定提交有效（§7.4） |
| 14 | MINOR | 备份只有一份；加固单元里 Docker 是否可用 | 写入 §6 和 §15，在 PR-C 定 |
| 15–17 | NIT | 证据未记录 origin 覆盖；O(n²)；EXECUTE 未说明 | 记录 `origin_overridden`；按索引扫描；§6 写明 |
