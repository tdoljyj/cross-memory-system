# Clued 扩大导入、Manual Review 与旧路径下线验收报告

> 日期：2026-08-25
> 状态：`全部 PASS`
> 正式入口：<https://clued.pixelgrav.com>
> Worker：`clued-cloud`

## 1. 授权与边界

用户明确授权全部执行此前列出的四项：扩大导入、26 条 manual-review 处置、PR merge、旧读取路径下线。

本轮不删除历史数据、审计事件或回执，不修改 Supabase schema、DNS、domain、route、Binding、secret，也不删除 Canary。旧路径下线只移除 UI/Worker 可写入口并返回明确的 `410 Gone`；已有证据继续保留。

## 2. 扩大导入验收

User Memory Bundle `umb_fdb167fd46d84c16047af70d` 的最终执行证据为：

- 4 个 Project、262 条 Unified Record 已通过用户认证 API 导入；
- 认证回读 `262/262`；
- 同 Bundle 重放保持 262 个 canonical ID 与 262 个版本稳定；
- 重放产生 262 个不同 Event ID 和 262 个不同 Receipt ID，证明幂等业务结果与逐请求审计同时成立；
- 匿名隔离 `401/401 PASS`；
- Bundle finalizer 的跨用户专项因没有第二个已确认账号而保持 `pending`，不以早期 Canary 证据冒充本次专项。

Clued 当前只读计数复核为 Project `4`、Record `262`，其中 Note/State/Task/Decision/Archive 为 `53/18/14/41/136`。262 条记录都保留同一 Bundle source ref，canonical ID 与 record key 均唯一。因此本轮不重复执行导入。

## 3. 26 条 Manual Review 处置

处置原则是“现有 canonical record 优先，旧 Markdown 行只作证据”，不因人工复核再次创建业务正文。

| # | Legacy ID | 处置 | 对应对象 | Canonical Record ID |
|---:|---|---|---|---|
| 1 | `legacy-28db4243635cd73d57c0778d` | 已取代的历史证据 | `mem_c642448c` | `ad0e7254-2cbc-41cd-be6a-40dfeca906cc` |
| 2 | `legacy-e65c7fa27bd779fa957b261c` | canonical reference | `mem_a69a84c2` | `0c47e80b-ce90-4327-9a15-427225aa3a1a` |
| 3 | `legacy-a8296872e7b7b73cc2e054c3` | canonical reference | `mem_80c0f792` | `95f54012-8f97-4fb5-88dc-615ee7eb56e3` |
| 4 | `legacy-23e64abd57f020588195a7f6` | canonical reference | `mem_3664c826` | `c3ec2b9f-1c4d-4467-877c-c705ce0dc61e` |
| 5 | `legacy-2b7ab4f7236054b0ff7ba1d3` | canonical reference | `mem_fd39a3ba` | `8c066e47-d5de-4b1a-bd57-d598ae0235c9` |
| 6 | `legacy-b18e53f475ce08a30f8835ee` | canonical reference | `mem_36f566f1` | `9d1c0c10-6b4b-47da-9c16-77446acd5503` |
| 7 | `legacy-b19b3add043976c6971a6760` | canonical reference | `mem_65d6ec06` | `0cac92bf-31e7-4034-8171-22cddd289fbd` |
| 8 | `legacy-e83c25edfe1bf49fade1bba3` | canonical reference | `mem_f35ccbb5` | `38f81d25-9397-4d83-b685-137e286213e1` |
| 9 | `legacy-a9dc134cb9e5c8f68c271ce3` | canonical reference | `mem_c37be801` | `69c8498c-ddec-4da8-9489-a4f12cd28e61` |
| 10 | `legacy-dafa6bf94c8ada271de223f0` | canonical reference | `mem_e575cdf0` | `e1330ac7-44a7-462f-9bec-80845d00d81d` |
| 11 | `legacy-646324d78e131975044d64f0` | canonical reference | `mem_18beb7ab` | `62db8a7a-86d7-4058-bec6-1fa063896509` |
| 12 | `legacy-717eaa5bbd2ee45afb9fc688` | canonical reference | `mem_c13fad46` | `1bcaaf46-89e4-4548-9c7b-500b43a21538` |
| 13 | `legacy-db98f5ad659e1ae39e863fe2` | canonical project reference | `mem_463415ca` | `67879499-07df-4e6b-9441-4b0cfd07af9e` |
| 14 | `legacy-f111ee7f5d478ce2c78786c0` | canonical reference | `mem_55d14690` | `c6db3336-1543-48a8-a67f-7fe7fb2ba9e6` |
| 15 | `legacy-807d01dde40b18923430c220` | canonical reference | `mem_06628863` | `5bb53036-4f95-4369-98a8-cc74bd2e0589` |
| 16 | `legacy-b88b6796abfdd12d08a1ae23` | canonical reference | `mem_1dd8b1f9` | `4b9d9b23-8380-4bc6-b00e-2e66875deb1e` |
| 17 | `legacy-403b660bcb4d976564c9f25b` | canonical reference | `mem_dbeb22c4` | `fa54133a-a268-4abd-b265-6f87c34ef265` |
| 18 | `legacy-fcf26a962684ce64320d411a` | canonical reference | `mem_6075246f` | `8db87882-5952-4eea-b7e4-6882124220a0` |
| 19 | `legacy-ba1d18e0990e0b2333674ed2` | canonical reference | `mem_fb67a697` | `c2e2382d-6598-49cc-8b1d-d2497d4a79c7` |
| 20 | `legacy-e421e6077f8298bcffa54293` | canonical reference | `mem_f8cfccc3` | `d603567e-d7ce-4f29-9dce-093f26581b17` |
| 21 | `legacy-e463dc32d059c9f4f9987549` | canonical reference | `mem_a2f9955f` | `7117d09f-3381-4ac9-a666-5f0fe34f3384` |
| 22 | `legacy-86b908b16b9722051e579e25` | canonical reference | `mem_3b2998ab` | `78bbd2cb-0d2b-442c-a44e-547e28fdc7a2` |
| 23 | `legacy-0d112fba3a212f1da6712c8a` | canonical reference | `mem_0b2fdce4` | `a2defa78-9d13-4d6e-ab31-6a4c59a4f73b` |
| 24 | `legacy-da2cf4651e3c6fc2cfd85a75` | canonical reference | `mem_06b3cd91` | `53662810-5ba3-4d03-bf49-8cc37b42079a` |
| 25 | `legacy-d89f476470d94582084a3270` | canonical reference | `mem_59fe08dc` | `75ed6bd5-12aa-4629-b4c9-fa6ed6006e4b` |
| 26 | `legacy-2ff56b2c4763994a20136608` | canonical reference | `mem_65806bc8` | `45fab1dc-e81f-4000-a10a-618386d3f985` |

裁决：25 条已有直接或项目语义 canonical 对应；1 条旧的组合状态已由“正式 V2 启用”当前状态取代。新增生产 Record `0`，Stage 5 dry-run 快照保持冻结不改。

## 4. 旧读取路径下线合同

- 账户页移除 legacy Memory 列表与创建、编辑、删除控件，只保留 Project、Unified Record 五视图和 Continuity。
- `/api/memories` 与 `/api/memories/audit` 对所有非 `OPTIONS` 请求返回 HTTP `410 Gone`。
- 410 响应固定给出 `replacement=/v1/records` 与 `semantic_contract=two-level-five-view-v1`。
- CORS 预检继续返回 204；Worker 不向 Supabase 发起 legacy 上游调用。
- 原始 legacy 表、行、审计和历史证据均不删除。

## 5. 发布前冻结点与门禁

- 发布前正式 deployment：`a536f79d-c9f5-4764-8274-be05f3cc5a3c`。
- 发布前正式 Version / 即时回滚点：`928bb6ec-cdc2-4a9a-a630-87a1685e7915`。
- Git `origin/main` 与本地基线均为 `95c2e5b49f630bb4bc19ae93d837a704f0e64779`。
- Wrangler `4.125.0`，登录账号与目标 Worker 已核对。
- TypeScript、ESLint、生产 build、Node 全套 `47/47` 已通过；合并后的 `main` 又完成一次干净生产构建。

## 6. PR、部署与发布后验收

- PR [#5](https://github.com/tdoljyj/cross-memory-system/pull/5) 已合并；source commit `b13f5feea997b4acce321a7c464e7ad952e2180b`，merge commit `21b7b947f47aca66c9c38abc7c741ef29e954aab`。
- 部署从已合并且与 `origin/main` 对齐的 `main` 构建；Wrangler dry-run PASS，使用 `--keep-vars --strict`，只显式保持 `PROJECT_VIEWS_V2=true`。
- 正式 deployment：`8c42f2cc-9591-4a54-8270-da364a0fe5f1`。
- 正式 Version：`bb56e002-583f-4893-b53a-6a347267a978`，100% 流量，Worker Startup Time `19 ms`。
- Bindings 仍为 `ASSETS`、`IMAGES`、`PROJECT_VIEWS_V2=true`；未改 DNS、domain、route、secret 或数据库。
- `clued.pixelgrav.com` 与 workers.dev 均通过：`/healthz` 200、V2 config 200/enabled、两个 legacy 路径 410、未认证 `/v1/records` 401、首页 200。
- 两个 legacy 路径的 GET/POST/PATCH/DELETE 均为 410，OPTIONS 均为 204；响应 replacement 与 semantic contract 正确。
- 正式入口固定 10 轮只读观察 `10/10 PASS`，意外 5xx 为 0，未触发回滚。
- 发布后 Clued canonical 计数仍为 Project `4`、Note/State/Task/Decision/Archive `53/18/14/41/136`，合计 Record `262`，无数据漂移。

最终裁决：扩大导入、26 条 manual-review、PR merge、旧读取路径下线全部完成。回滚点 `928bb6ec-cdc2-4a9a-a630-87a1685e7915` 继续保留；历史数据、审计证据和 Canary 均未删除。
