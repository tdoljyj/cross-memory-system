# Projection refresh watchdog (activation runbook)

Scope: only `global.priority_frontier` and `global.__aggregate__`. This is an
independent operational alarm, not a Canonical writer, Projection Builder, or
source of current action. A healthy alarm is never evidence that a projection
is CURRENT; readers still use KooYomi currentness and fail closed.

## Components and permissions

- 看门狗根据投影积压、任务结果和摘要比较判断异常。Worker 空闲、暂停定时触发，或尚无运行记录时，均可正常读取状态。
- Migration `20260923213200_projection_refresh_watchdog.sql` exposes one bounded
  status snapshot in the isolated `clued_watchdog` schema to the
  `clued_projection_watchdog` NOLOGIN role. It includes
  only a tenant hash, the two projection keys, revisions, queue status,
  source-digest comparison, and tick timestamps/result. It does not expose
  Canonical bodies, tokens, Builder leases, or direct private schema/table access.
- An operator provisions a separate LOGIN role that inherits **only**
  `clued_projection_watchdog`, with a rotated password stored in the approved
  secret store. Do not use a service-role, writer, Builder, or pooled app URL.
  Test that this role can call the snapshot and cannot select private tables or
  call Builder RPCs before scheduling it.
- Run `node scripts/projection-watchdog.mjs` in an independent, single-instance
  scheduler outside the refresh Worker and with persistent state
  storage. It must restart on failure and have its own job-failure alert. Use a
  private state path and restrict filesystem ACLs to the monitor identity. A
  transient monitoring/database failure must itself create an alert; the
  monitor must not use old cached CURRENT values as a substitute.

Environment for the independent monitor:

| Variable | Purpose |
| --- | --- |
| `CLUED_WATCHDOG_DATABASE_URL` | Narrow LOGIN role connection URL. |
| `CLUED_WATCHDOG_STATE_PATH` | Durable path for active incident IDs. |
| `CLUED_ALERT_CF_ACCOUNT_ID` | Cloudflare account ID. |
| `CLUED_ALERT_CF_API_TOKEN` | Narrow Email Sending API token. |
| `CLUED_ALERT_FROM` | Verified KooYomi alert sender. |
| `CLUED_ALERT_TO` | Owner-provided destination, stored as a secret. |
| `CLUED_WATCHDOG_DRY_RUN` | `1` checks logic without delivery or state advance. |

Do not check any of these values into Git. The recipient is intentionally not
in source. Cloudflare Email Sending must be enabled for the account, sender
domain and destination verified where required, and API permissions confirmed
by a controlled test message. An attempted capability check on 2026-09-23
returned `Unauthorized (2036)`, so live email delivery is **not activated or
verified** by this change. Do not schedule this monitor as production-active
until the delivery path and its independent job-failure alarm are proved.

数据库中的每小时任务另有 SQL 判定入口 `clued_watchdog.projection_watchdog_tick()`。下面的信号说明针对本页的 Node.js 脚本。

## Signals and behavior

- 快照若明确报告传输或 Builder 协议错误或异常，保留 `WORKER_DEGRADED` 告警。
- Terminal queue failure, missing job while invalidation is unresolved, or
  unresolved invalidation older than five minutes.
- Revision going backwards, stored digest diverging from the latest complete
  source vector, or missing comparison evidence. The durable monitor state
  retains the set of previously observed tenant hashes so a tenant whose two
  heads both disappear is also detected after at least one successful poll.
- Monitor read failure, including malformed status responses.

Incidents are keyed per tenant/projection/symptom and normally notified only on
opening and recovery. Delivery is at-least-once: a crash after provider acceptance
but before state persistence can produce a duplicate. The state advances only after the email provider accepts the
notification. The email contains bounded status codes, never Canonical text.
Queued/accepted mail is **not** proof of inbox delivery; verify a real inbox
receipt during activation. The runner requires a single instance because its
file-backed dedup state is not a distributed lock. Do not use two concurrent
replicas against the same state file.

## Activation and rollback gate

1. Apply the migration through the separately authorized database release.
   Grant only the NOLOGIN watchdog role to the dedicated LOGIN monitor identity.
2. 核对快照可读，并确认服务租户、两个投影键、修订和摘要状态。
3. Configure the independent scheduler and secrets, dry-run on synthetic
   conditions, then prove an actual email reaches the approved inbox. Inject a
   synthetic overdue backlog and recovery, confirm one alert and one recovery.
4. Check both projections' currentness from independent Host/Agent reads.
   Record UTC timestamps, revision/digest status, and delivery receipts without
   storing Canonical content in the monitor log.

First-time monitoring cannot identify a tenant that has never appeared in a
snapshot; compare the initial tracked-tenant count against the separately
approved account inventory at activation. Legitimate tenant removal requires
an operator-reviewed reset of the retained tenant set.

If alert delivery or the independent scheduler is unavailable, report
monitoring as **inactive**, retain KooYomi's STALE/UNKNOWN read boundary, and do
not claim the system can self-detect future outages. Rollback the monitor by
disabling its independent schedule; leave Canonical, invalidation, and
projection semantics untouched. Preserve the state and diagnostic logs for
forensics.
