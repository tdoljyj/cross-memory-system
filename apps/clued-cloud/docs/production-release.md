# KooYomi Cloud production release

The supported production Worker release entry is the owner-dispatched
`Clued Cloud production release` GitHub Actions workflow on `main`. It checks
the exact checkout, builds and tests it, verifies the production database,
deploys `clued-cloud`, and then verifies the live source commit and both
projection keys from the read-only status snapshot. A failing preflight
stops before `wrangler deploy`.
The production Wrangler configuration also runs the read-only preflight as its
build command, so a direct Wrangler deployment using that configuration fails
when the database credential or required production state is missing.
Every dispatch chooses exactly one `mode`; only `deploy` changes production.
The default is `preflight`, and an unknown mode fails before any production
credential is read, so a dispatch whose inputs are missing or misparsed never
falls through to a deploy. From the GitHub API or a connector, pass the input
as the string `{"mode": "deploy"}` (or `"preflight"`, `"backup"`,
`"source-capture"`, `"migrate"` with `migrations`).

- `preflight` verifies the live database and stores evidence without needing a
  Cloudflare token or changing production.
- `backup` runs before an authorized schema migration when the target has no
  confirmed managed backup/PITR restore point. It creates a custom-format dump
  of the schemas affected by KooYomi migrations, validates the dump and encrypted
  round-trip, destroys runner plaintext, and uploads only the encrypted dump
  plus a checksum manifest.
- `source-capture` captures one reviewed nonsecret storage client source and
  requires `source_request_id` and `source_request_digest`.
- `deploy` builds, gates, deploys `clued-cloud` and runs the post-deploy checks.

The workflow needs the `CLUED_ATTESTATION_DATABASE_URL_V2` secret, a
`CLUED_CLOUDFLARE_DEPLOY_TOKEN_V2` secret scoped to edit the existing `clued-cloud`
Worker, and the `CLUED_CLOUDFLARE_ACCOUNT_ID` repository variable. Both secrets
were renamed (from the names without `_V2`) after re-review 4, finding M2: a
re-run replays a run's own workflow file, so a release run from before the
Owner Grant door could deploy an old commit with no grant. With the old names
removed, such a re-run gets no deploy credentials. Both `_V2` secrets are
secrets of the `clued-release` environment (deployment branches: `main` only),
never repository secrets (re-review 5, finding N1): a repository secret reaches
a workflow that any pushed branch adds, while an environment secret reaches
only jobs that declare the environment and run from `main`. Every job that
reads them (this release job, the storage executor window, the storage read
config and the post-deploy attestation) declares `environment: clued-release`;
`tests/production-release-gate.test.mjs` checks that. The token
belongs in GitHub secret storage; never put it in Git, logs, an artifact, or a
command argument. Backup mode additionally requires a high-entropy
`CLUED_PRODUCTION_BACKUP_KEY` GitHub secret; retain it while any encrypted
backup artifact may be needed. Keep the reviewed schedule and existing Worker bindings in
`wrangler.production.jsonc`; deployment uses `--keep-vars`.

## 发布门（Owner Grant）

`deploy` 和 `migrate` 改变生产之前，都要为这次提交消费一条 Owner 授权（`deploy`：动作
`release.production`，资源 `repo:<仓库>/<40 位 sha>`；`migrate`：动作 `migration.production`，
资源是这次点名的每个迁移文件，并捎带同一提交的 `deploy`，一次批准两件）。门是数据库函数
`clued_private.release_door_v1(jsonb)`，只有 `clued-release` 环境里 `CLUED_MIGRATION_DATABASE_URL`
的数据库登录角色能调用；它不在 PostgREST 上，没有发布令牌，也没有到期和轮换。工作流用 psql
调它，输入以 COPY 数据传入，不拼进 SQL；`scripts/ci/clued-release-door.mjs` 只负责组装输入、
解析回答、写运行摘要，并把拒绝原因翻成中文的下一步。没有“仅提示”模式：没消费到授权就停。

- `migrate`：消费发生在第一条迁移文件的事务里，顺序是消费 → 执行文件 → 探门（`probe`）→
  记 `schema_migrations` → 提交。没消费到就整体回滚，再用 `request_only` 留下一条待确认请求，
  运行打印确认链接后失败；Owner 批准后重跑即可。每条文件的事务提交前都探门，所以把门弄坏的
  迁移提交不了；第一条文件执行出错时授权也随之回滚，不会被用掉。
- `deploy`：在发布闸门和凭据检查之后、任何 `wrangler` 之前，单独一步消费；门不存在时失败。
- 自举（只发生一次）：门还不存在时，只有 md5 等于工作流里 `RELEASE_DOOR_INSTALL_MD5` 的安装迁移
  （`20261119130000_release_door_db_identity_v1.sql`）能作为第一条执行；它在同一事务里装上门、经新门消费授权、
  探门、记账，任何一步不成整体回滚。顺序：`backup` → `migrate`（只填安装迁移）→ `migrate`
  （其余待跑迁移）→ `deploy`。`tests/production-release-gate.test.mjs` 要求
  `RELEASE_DOOR_INSTALL_MD5` 等于仓库里这份安装迁移的 md5。

`tests/production-release-door-flow-db.test.mjs` 对一次性数据库原样执行工作流的这两步。

## Database sequence

Apply reviewed schema migrations to production through the authorized
Supabase process **before** dispatching the Worker release. The release gate
reads `supabase_migrations.schema_migrations` and compares the recorded SQL
with repository files.

部署前和部署后都核对迁移前置项、SQL、生产迁移账本、frontier 的 MTPE 定义，以及状态快照是否可读、观测时间是否在两分钟内。迁移后在下一个 PR 记录新增的生产账本行，流程见 `docs/maintenance/migration-ledger.md`。

`--pre-deploy` 在凭据中保留 Builder 服务的 `global.priority_frontier` 和 `global.__aggregate__` 的租户、修订、任务状态、积压起点和摘要比较结果。异常写入 `warnings` 并输出到发布日志，允许修复旧 Worker 的版本继续部署。

`--post-deploy` 要求两个必需键均有服务行，每行的修订已追平、摘要一致。未满五分钟的积压每十秒重读一次，最多等待约三分钟。任务失败、摘要不符、积压已满五分钟或等待结束仍未追平时，验收失败并报告具体投影键。即使 cron 关闭且没有心跳，已追平的快照也能立即通过。

Production migration history predates a unified versioning convention. The
MTPE source file `20260924110000_mtpe_universal_intake_auto_priority.sql` was
applied on 2026-09-23 as history version `20260923050444`; the SQL is identical
except for a trailing CRLF in the stored statement. The immutable
`scripts/production-release-baseline.json` records that one observed alias
and its source SHA-256. The release gate compares the full statement, not
just the migration name. It also refuses any modification to a migration
already present in the baseline commit.

New migration filenames must sort after the baseline migration. Each new
file must have exactly one production history row with the same name and SQL
body; the production service may assign a different version number. If a
migration is missing or the SQL differs, apply or reconcile the migration
through an authorized, evidence-backed operation, then rerun the release.
Do not run a blind `supabase db push` against this historically divergent
production ledger or mark a migration applied without checking its live SQL.

## After a database restore

Restoring production from a backup or PITR point brings the work-claims table
back to that point, and a claim's fence is `max(fence)+1` over that table, so
new claims would get fences already issued after the restore point. Before
any Agent works again, run
[`scripts/work-claims-after-restore.sql`](../scripts/work-claims-after-restore.sql)
once against the restored database. It abandons the claims the restore brought
back as live and raises every fence by one million. Agents then claim again;
a claim issued after the restore point verifies as `claim_not_found`. This is
a known limit of Work Claim Admission v0.1 (§4.4, Owner Decision `2b23eb0c`).

## Release evidence

The workflow stores three safe artifacts: the preflight result, the exact
deployed-commit/currentness attestation, and the post-deploy projection result.
The database URL, Cloudflare token and full SQL are omitted. A failed
post-deploy check means the release is not accepted; currentness reads continue
to fail closed until the underlying state is repaired.

For an authorized manual operation outside GitHub Actions, run the read-only
`node scripts/production-release-gate.mjs --pre-deploy` immediately before
the release and use `--post-deploy` afterward. A manual `wrangler deploy` without this gate
has no release acceptance evidence.

## Avoid duplicate standalone preflight dispatches

Before dispatching `mode=preflight`, look for an existing successful standalone
preflight run for the exact intended checkout SHA. Record the run URL and its
safe preflight evidence in the release handoff. A failed, cancelled, incomplete
or unavailable result cannot be reused.

An exact SHA alone does not establish that a production-state check is still
valid. Reuse is limited to the same target and checked prerequisites: migration
files and production ledger, database history, relevant configuration and
authorization, and a readable, fresh projection snapshot. When any
prerequisite changed, freshness expired, or equivalence cannot be established,
run a new preflight and state the reason. Do not invent a freshness guarantee
from elapsed time or a green historical run.

When the evidence remains applicable, refer to the existing run instead of
dispatching the same standalone preflight again. This does not skip the `deploy`
workflow's own fresh pre-deploy gate, its build/test steps, Owner Grant check or
post-deploy acceptance checks. Backup and migration dispatches are distinct
operations and are not duplicates merely because they use the same source SHA.

Task `4d614afb` tracks this cost-control rule and its validation. The 2026-10-09
point-in-time investigation classified 203 workflow runs from their latest
attempt logs: 87 deploy, 51 backup, 59 migrate, 5 preflight and 1 unknown mode.
The only repeated preflight SHA had one failed run followed by one successful
run; the investigation did not establish a redundant successful preflight.
All runs used the shared GitHub actor `tdoljyj`, which does not identify the
individual human or Agent that initiated a dispatch. These observations are
not a final billing reconciliation or a reason to remove required production
checks.
