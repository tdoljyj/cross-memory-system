// 第 18 代故障转移演练测试的夹具（任务 04f9b91b，D:/w/tmp/PLAN-failover-drill-gen18-addendum-20261124.md 第 1 节第 2、9、10 条与第 2 节 E4）。
// 形状的来源：
//   - 空闲读数与 status.json：test/fixtures/failover-drill-gen18-readings.json，2026-11-24 北京 21:24–21:26 在 DESK 上只读取样
//     （gh run list、gh pr list、shadow-compare.mjs、本机 status.json；裁剪说明见该文件 _source）。
//   - 快照：drill/failover-drill.mjs 的 snapshotSql 返回的 jsonb（page 与 public.clued_resident_failover_v1 同形，
//     迁移 20261031090000 第 1320–1362 行；节点视图是 ci_failover_node_view_v1；steady_since 出自 ci_node_liveness_v1，迁移 20261115120000）。
//     DESK 用 Supabase MCP 读时外面多包一层 [{ "snapshot": ... }]。
// 时间线是 11-15 那次演练的真实节奏：北京 11:51:34 断网、11:57:00 交接、12:00:34 复网、12:05:34 才健康（steady_since），
// 资格在复网后约 35 分钟恢复。绑定号是合成的。
import fs from 'node:fs';

export const READINGS = JSON.parse(fs.readFileSync(new URL('./fixtures/failover-drill-gen18-readings.json', import.meta.url), 'utf8'));
export const TURING = '11111111-1111-4111-8111-111111111111';
export const DESK = '22222222-2222-4222-8222-222222222222';
// 第 17 代起两台的 Source（取样的 status.json 上就是它）
export const SOURCE = READINGS.statusDesk.versions.windows.ciSourceManifestSha256;
export const at = (hhmmss, day = '2026-11-15') => `${day}T${hhmmss}.000Z`; // UTC；北京 = UTC+8
export const plus = (iso, seconds) => new Date(Date.parse(iso) + seconds * 1000).toISOString();
export const clone = v => structuredClone(v);

export const T0 = at('03:51:34');          // 北京 11:51:34 断网
export const HANDOVER = at('03:57:00');    // 北京 11:57:00 交接
export const RESTORED = at('04:00:34');    // 断网 9 分钟后复网
export const STEADY = at('04:05:34');      // 复网 5 分钟后才健康（11-15 的真实节奏）

export function node({ mode, probe, heartbeat, state = 'NORMAL', halt = null, running = true, unhealthy = null, source = SOURCE }) {
  return { mode, probe, state, readable_state: state, halt, service_running: running, unhealthy_since: unhealthy,
    last_heartbeat_at: heartbeat, ci_source_manifest_sha256: source };
}
export function page(observed, { holder, turing, desk, alerts = [] }) {
  return { status: 'ok', observed_at: observed,
    setting: { enabled: true }, rules: { silence_minutes: 5, unhealthy_minutes: 5, rejoin_steady_minutes: 30 },
    members: [{ binding_id: TURING, rank: 1 }, { binding_id: DESK, rank: 2 }],
    holders: [{ binding_id: holder, purpose: 'resident-node' }],
    nodes: [{ binding_id: TURING, node: turing }, { binding_id: DESK, node: desk }],
    watchdog: { last_tick_at: observed, stale: false }, alerts };
}
export const handoverReceipt = (over = {}, id = 'a0000000-0000-4000-8000-000000000001') => ({ id, created_at: HANDOVER, operation: 'binding_role_handover',
  metadata: { receipt_kind: 'CI_ADMISSION_AUTO_HANDOVER', trigger: 'silence', from_binding_id: TURING, to_binding_id: DESK,
    holder_last_heartbeat_at: at('03:51:20'), effective_at: plus(HANDOVER, 0.02), ...over } });
// 页 alerts 里的一条（与页函数同形：receipt_id、receipt_kind 等摊平）
export const alertOf = r => ({ receipt_id: r.id, created_at: r.created_at, receipt_kind: r.metadata.receipt_kind, reason: r.metadata.reason ?? null,
  from_binding_id: r.metadata.from_binding_id ?? null, to_binding_id: r.metadata.to_binding_id ?? null, trigger: r.metadata.trigger ?? null,
  effective_at: r.metadata.effective_at ?? null });

export function snapshot(serverTime, { page: p, steady = null, lastHeartbeat = null, receipts = [], duty = [], exclusion = null, candidates = [], since = at('03:40:00') }) {
  return { server_time: serverTime, turing: TURING, desk: DESK, since, page: p,
    turing_liveness: { steady_since: steady, last_heartbeat_at: lastHeartbeat }, receipts, duty_answers: duty, exclusion, candidates };
}

// 本机 status.json：取样的 DESK 那份，按需改几处
export function status({ mode = 'ACTIVE', probe = mode === 'ACTIVE' ? 'held' : 'not-held', selfcheck = 'PASS', live = 0, current = null, writtenAt, generation } = {}) {
  const s = clone(READINGS.statusDesk);
  s.node.mode = mode; s.node.probe.result = probe; s.current = current; s.queue.live = live;
  s.versions.selfcheck.result = selfcheck;
  if (generation !== undefined) s.versions.generation = generation;
  if (writtenAt) s.writtenAt = writtenAt;
  return s;
}

// --- 放行前 ---------------------------------------------------------------
export const NOW = '2026-11-24T13:25:00.000Z';
export function gateParts() {
  const observed = plus(NOW, -20);
  const p = page(observed, { holder: TURING, turing: node({ mode: 'ACTIVE', probe: 'held', heartbeat: plus(NOW, -40) }),
    desk: node({ mode: 'STANDBY', probe: 'not-held', heartbeat: plus(NOW, -30) }) });
  const shadow = clone(READINGS.shadow);
  shadow.summary.counts['在跑'] = 0;    // 取样时在跑 4；空闲时是 0
  return {
    turing: TURING, desk: DESK, source: SOURCE, now: NOW,
    snapshot: snapshot(observed, { page: p, candidates: [{ binding_id: DESK, rank: 2, agent_name: 'desk', eligible: true, reasons: [], last_heartbeat_at: plus(NOW, -30), heartbeat_previous_at: plus(NOW, -60) }] }),
    // TURING 当班时 pending 仍可能有展示用的行（取样里 #1240 等是 QUEUED）；I4 只看 current 与 queue.live
    statusTuring: status({ writtenAt: plus(NOW, -10) }),
    statusDesk: status({ mode: 'STANDBY', live: 61, writtenAt: plus(NOW, -5) }),
    idle: {
      // 取样里排队的有定时与手动触发的（clued-front-main-merge、clued-compute-panel），它们不挡；在跑的三条都是 pull_request，空闲时没有
      runsInProgress: [],
      runsQueued: READINGS.runsQueued.filter(r => r.event === 'schedule' || r.event === 'workflow_dispatch'),
      // #1292：检查都完成，只剩常驻的 resident-queue/turing (info only) PENDING；#885 草稿；#880 有 FAILURE 的状态
      prs: READINGS.prs.filter(p => p.number !== 1298),
      shadow,
      vms: [{ Name: 'drill', State: 'Off' }],
    },
  };
}

// --- 演练后 ---------------------------------------------------------------
export function drillParts() {
  const turingDown = node({ mode: 'ACTIVE', probe: 'held', heartbeat: at('03:51:20') });
  const turingBack = hb => node({ mode: 'STANDBY', probe: 'not-held', heartbeat: hb });
  const deskActive = hb => node({ mode: 'ACTIVE', probe: 'held', heartbeat: hb });
  const r1 = handoverReceipt();
  const duty = [{ binding_id: TURING, at: at('03:51:10') }, { binding_id: DESK, at: at('03:57:51') }, { binding_id: DESK, at: at('04:06:20') }];
  const snapshots = [
    // T0+15 分钟：DESK 当班，TURING 已健康 1 分钟（steady_since 12:05:34），仍被排除
    snapshot(plus(T0, 15 * 60), { page: page(plus(T0, 15 * 60), { holder: DESK, turing: turingBack(at('04:06:20')), desk: deskActive(at('04:06:25')), alerts: [alertOf(r1)] }),
      steady: STEADY, lastHeartbeat: at('04:06:20'), receipts: [r1], duty, exclusion: 'auto_handed_out', since: T0 }),
    // 末次：max(T0+45 分钟, steady_since+31 分钟) = 12:36:34，资格已恢复
    snapshot(plus(STEADY, 31 * 60), { page: page(plus(STEADY, 31 * 60), { holder: DESK, turing: turingBack(at('04:36:20')), desk: deskActive(at('04:36:25')), alerts: [alertOf(r1)] }),
      steady: STEADY, lastHeartbeat: at('04:36:20'), receipts: [r1], duty: [...duty, { binding_id: DESK, at: at('04:36:00') }], exclusion: null, since: T0 }),
  ];
  return {
    turing: TURING, desk: DESK, snapshots,
    cut: { drillId: 'gen18', outcome: 'CUT_DONE', t0: T0, restoredAt: RESTORED, adapters: ['Ethernet'], enableFailed: [], connected: true, backstopRemoved: true },
    statusTuring: status({ mode: 'STANDBY' }), statusDesk: status(),
  };
}
