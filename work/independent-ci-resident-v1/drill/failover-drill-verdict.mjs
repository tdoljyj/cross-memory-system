// 第 18 代故障转移演练的判定（任务 04f9b91b，D:/w/tmp/PLAN-failover-drill-gen18-20261124.md 第 4、6 节）。
// 纯函数：不联网、不读写文件。输入是 DESK 读出来的东西，输出逐条的过或不过和原因：
//   ok: true 过；false 不过；null 未判定（读不到、窗口没读到，或 B3 的“相位不凑巧”）。
// 总判：有一条 false 即 FAIL；否则有一条 null 即 UNDETERMINED；全 true 才 PASS。读不到永远不判 PASS。
//
// gateVerdict(input) 放行前 A1–A7、I1–I6：
//   { turing, desk,            两台的 CI 连接 binding_id
//     page,                    public.clued_resident_failover_v1({}) 的返回（/bindings/failover 页读的那个）
//     statusTuring, statusDesk, 两台本机 C:\ProgramData\CluedIndependentCI\resident\state\status.json
//     candidates,              clued_private.ci_failover_candidates_v1(<owner>, <turing>, <turing 的 Source>, null, now()) 的返回
//     idle: { runsInProgress, runsQueued,   gh run list --status in_progress|queued --json databaseId
//             prs,                          gh pr list --state open --json number,isDraft,statusCheckRollup
//             shadow,                       node scripts/ci/shadow-compare.mjs --prs <起点>- 的输出
//             vms,                          DESK 本机 Get-VM 的 [{ Name, State }]
//             deskPushImminent } }          DESK 马上要推的项（空数组＝没有）
// drillVerdict(input) 演练后 B1–B11：
//   { turing, desk,
//     cut,                     TURING 上断网脚本的结果文件（failover-drill-<id>.result.json）
//     pages,                   放行后各次读到的页（每个带 observed_at；B4 从 T0+3 分钟起每 30 秒一次，B6 复网后，B7 到 T0+45 分钟后）
//     receipts,                clued_audit_receipts 里 created_at >= T0 的行 [{ id, created_at, operation, metadata }]
//     dutyAnswers,             clued_private.ci_duty_answers_v1 里两台 at >= T0 的行 [{ binding_id, at }]
//     exclusions,              clued_private.ci_failover_exclusion_v1(<owner>, <turing>, now()) 各次的 [{ at, value }]
//     statusTuring, statusDesk } 演练后两台 status.json
export const RULES = Object.freeze({
  generation: 18,
  heartbeatFreshSeconds: 120,        // A3、A4：心跳 2 分钟内
  rules: Object.freeze({ silence_minutes: 5, unhealthy_minutes: 5, rejoin_steady_minutes: 30 }), // A6：5/5/30
  silenceSeconds: [300, 390],        // B2：交接 − 最后心跳在 5 分 00 秒到 6 分 30 秒
  effectiveSeconds: 10,              // B3：立即生效
  delayedEffectiveSeconds: 290,      // B3：延后（5 分钟）生效判“相位不凑巧”
  onDutySeconds: 120,                // B4：交接后 2 分钟内 DESK 当班
  standbyMinutes: 10,                // B6：复网后 10 分钟内 TURING 待命
  noTakeBackMinutes: 45,             // B7：到 T0+45 分钟没有第 2 条自动交接
  excludedBeforeMinutes: 29,         // B8：复网后 29 分钟以内仍 auto_handed_out
  rejoinedMinutes: Object.freeze([31, 35]), // B9：复网后 31–35 分钟已恢复（null）
});
const AUTO = 'CI_ADMISSION_AUTO_HANDOVER';
const ALERTS = ['CI_ADMISSION_FAILOVER_WITHHELD', 'CI_ADMISSION_FAILOVER_NO_TARGET'];

const pass = why => ({ ok: true, why });
const fail = why => ({ ok: false, why });
const unknown = why => ({ ok: null, why });
const ms = v => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
const arr = v => (Array.isArray(v) ? v : null);
const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const sec = n => `${Math.round(n / 100) / 10} 秒`;

// 一条判据算不出来（输入缺、形状不对）就是未判定，不让整个判定抛出去。
function judge(fn) {
  try { return fn() ?? unknown('读不到'); } catch (e) { return unknown(`读不到：${e?.message ?? e}`); }
}
export function overall(checks) {
  const v = Object.values(checks);
  return v.some(c => c.ok === false) ? 'FAIL' : v.some(c => c.ok !== true) ? 'UNDETERMINED' : 'PASS';
}
const need = (v, what) => { if (v === undefined || v === null) throw new Error(`缺 ${what}`); return v; };
const nodeOf = (page, binding) => {
  const nodes = need(arr(page?.nodes), 'page.nodes');
  const n = nodes.find(x => x?.binding_id === binding)?.node;
  return obj(n);
};
const holdersOf = page => need(arr(page?.holders), 'page.holders');
const onlyHolder = (page, binding) => { const h = holdersOf(page); return h.length === 1 && h[0]?.binding_id === binding; };
const selfcheckOf = s => obj(s)?.versions?.selfcheck?.result ?? null;

function nodeProblems(n, want, observedMs) {
  if (!n) return ['没有该节点'];
  const out = [];
  for (const [k, v] of Object.entries(want)) if (n[k] !== v) out.push(`${k}=${JSON.stringify(n[k])}`);
  const hb = ms(n.last_heartbeat_at);
  if (observedMs !== undefined && (hb === null || observedMs - hb > RULES.heartbeatFreshSeconds * 1000)) out.push(`心跳 ${n.last_heartbeat_at ?? '无'} 超过 2 分钟`);
  return out;
}

// ---------------------------------------------------------------------------
// 放行前
export function gateVerdict(input) {
  const g = obj(input) ?? {};
  const { turing, desk, page } = g;
  const idle = obj(g.idle) ?? {};
  const checks = {};
  const observed = () => need(ms(page?.observed_at), 'page.observed_at');

  checks.A1 = judge(() => {
    const st = need(obj(g.statusTuring), 'TURING status.json'), sd = need(obj(g.statusDesk), 'DESK status.json');
    const bad = [];
    for (const [name, s] of [['TURING', st], ['DESK', sd]]) {
      if (selfcheckOf(s) !== 'PASS') bad.push(`${name} selfcheck=${selfcheckOf(s)}`);
      if (s.versions?.generation !== RULES.generation) bad.push(`${name} 第 ${s.versions?.generation ?? '?'} 代`);
    }
    const a = nodeOf(page, turing)?.ci_source_manifest_sha256, b = nodeOf(page, desk)?.ci_source_manifest_sha256;
    if (!a || a !== b) bad.push(`Source 不同或缺（${a ?? '无'} / ${b ?? '无'}）`);
    return bad.length ? fail(bad.join('；')) : pass(`两台 selfcheck PASS，第 ${RULES.generation} 代，Source 相同`);
  });
  checks.A2 = judge(() => {
    const h = holdersOf(page);
    return h.length === 1 && h[0]?.binding_id === turing && h[0]?.purpose === 'resident-node'
      ? pass('持有者只有 TURING（resident-node）') : fail(`持有者 ${JSON.stringify(h.map(x => [x?.binding_id, x?.purpose]))}`);
  });
  checks.A3 = judge(() => {
    const bad = nodeProblems(nodeOf(page, turing), { mode: 'ACTIVE', probe: 'held', state: 'NORMAL', readable_state: 'NORMAL', halt: null, service_running: true }, observed());
    return bad.length ? fail(`TURING：${bad.join('、')}`) : pass('TURING 当班、NORMAL、心跳新');
  });
  checks.A4 = judge(() => {
    const bad = nodeProblems(nodeOf(page, desk), { mode: 'STANDBY', probe: 'not-held', state: 'NORMAL', unhealthy_since: null }, observed());
    return bad.length ? fail(`DESK：${bad.join('、')}`) : pass('DESK 待命、NORMAL、心跳新');
  });
  checks.A5 = judge(() => {
    const c = need(arr(g.candidates), 'candidates').find(x => x?.binding_id === desk);
    if (!c) return fail('候选里没有 DESK');
    return c.eligible === true ? pass('DESK 是合格候选') : fail(`DESK 不合格：${JSON.stringify(c.reasons ?? [])}`);
  });
  checks.A6 = judge(() => {
    const p = need(obj(page), 'page'), bad = [];
    if (need(obj(p.setting), 'page.setting').enabled !== true) bad.push('总开关关着');
    const members = need(arr(p.members), 'page.members').map(m => m?.binding_id);
    if (!members.includes(turing) || !members.includes(desk)) bad.push('成员表不含两台');
    if (need(obj(p.watchdog), 'page.watchdog').stale !== false) bad.push('看门狗过期');
    const rules = need(obj(p.rules), 'page.rules');
    for (const [k, v] of Object.entries(RULES.rules)) if (rules[k] !== v) bad.push(`${k}=${rules[k]}`);
    return bad.length ? fail(bad.join('；')) : pass('开关开、两台在成员表、看门狗新、规则 5/5/30');
  });

  checks.I1 = judge(() => {
    const a = need(arr(idle.runsInProgress), 'runsInProgress'), b = need(arr(idle.runsQueued), 'runsQueued');
    return a.length + b.length === 0 ? pass('没有排队或在跑的工作流') : fail(`在跑 ${a.length}、排队 ${b.length}`);
  });
  checks.I2 = judge(() => {
    const open = need(arr(idle.prs), 'prs').filter(p => p && p.isDraft !== true);
    const busy = open.filter(p => need(arr(p.statusCheckRollup), `#${p.number} statusCheckRollup`).some(c =>
      c?.__typename === 'StatusContext' ? ['PENDING', 'EXPECTED'].includes(c.state) : c?.status !== 'COMPLETED'));
    return busy.length ? fail(`有未完成检查的 PR：${busy.map(p => `#${p.number}`).join('、')}`) : pass('open 非草稿 PR 的检查都已完成');
  });
  checks.I3 = judge(() => {
    const s = need(obj(idle.shadow), 'shadow');
    if (s.status === 'error') return unknown(`影子对比读取失败：${s.error ?? ''}`);
    const running = need(obj(s.counts), 'shadow.counts')['在跑'] ?? 0;
    const pending = need(s.pendingMergedHeads, 'shadow.pendingMergedHeads');
    return running === 0 && pending === 0 ? pass('影子对比在跑 0、已合入未出结论 0') : fail(`在跑 ${running}、已合入未出结论 ${pending}`);
  });
  // 合并队列与停靠的批次：当班节点 TURING 的 status.json（current 是在途批次，pending 含停靠的 PARKED 行）。
  checks.I4 = judge(() => {
    const s = need(obj(g.statusTuring), 'TURING status.json');
    const pending = need(arr(s.pending), 'TURING pending');
    return s.current === null && pending.length === 0 ? pass('TURING 队列空、没有停靠的批次')
      : fail(`TURING 在途 ${s.current ? `#${s.current.pr}` : '无'}、排队或停靠 ${pending.length}`);
  });
  checks.I5 = judge(() => {
    const on = need(arr(idle.vms), 'vms').filter(v => v?.State === 'Running' || v?.State === 2);
    return on.length ? fail(`DESK 上有虚拟机开着：${on.map(v => v.Name).join('、')}`) : pass('DESK 上没有虚拟机开着');
  });
  checks.I6 = judge(() => {
    const q = need(arr(idle.deskPushImminent), 'deskPushImminent');
    return q.length ? fail(`DESK 马上要推：${q.join('、')}`) : pass('DESK 推送队列没有马上要推的');
  });
  const idleChecks = ['I1', 'I2', 'I3', 'I4', 'I5', 'I6'].map(k => checks[k]);
  checks.A7 = idleChecks.some(c => c.ok === false) ? fail('列车不空闲（见 I1–I6）')
    : idleChecks.some(c => c.ok !== true) ? unknown('空闲判据有读不到的（见 I1–I6）') : pass('列车空闲');
  return { kind: 'gate', verdict: overall(checks), checks };
}

// ---------------------------------------------------------------------------
// 演练后
export function drillVerdict(input) {
  const d = obj(input) ?? {};
  const { turing, desk } = d;
  const cut = obj(d.cut);
  const t0 = () => need(ms(cut?.t0), '结果文件 t0');
  const restored = () => need(ms(cut?.restoredAt), '结果文件 restoredAt');
  const pages = () => need(arr(d.pages), 'pages').filter(p => ms(p?.observed_at) !== null).sort((a, b) => ms(a.observed_at) - ms(b.observed_at));
  const lastObserved = () => { const p = pages(); return p.length ? ms(p.at(-1).observed_at) : -Infinity; };
  // 自动交接：库里的回执优先；没给就用页上 alerts（字段已摊平）。
  const handovers = () => {
    const since = t0();
    const rows = arr(d.receipts);
    if (rows) {
      return rows.filter(r => r?.metadata?.receipt_kind === AUTO && ms(r.created_at) >= since)
        .map(r => ({ created_at: r.created_at, ...r.metadata }));
    }
    const p = pages().filter(x => arr(x.alerts));
    if (!p.length) throw new Error('缺回执与页 alerts');
    return p.at(-1).alerts.filter(a => a?.receipt_kind === AUTO && ms(a.created_at) >= since);
  };
  const theHandover = () => { const h = handovers(); return h.length >= 1 ? h.sort((a, b) => ms(a.created_at) - ms(b.created_at))[0] : null; };
  const checks = {};

  checks.B1 = judge(() => {
    const h = handovers();
    if (h.length !== 1) return fail(`窗口内自动交接 ${h.length} 条`);
    const [x] = h, bad = [];
    if (x.from_binding_id !== turing) bad.push(`from=${x.from_binding_id}`);
    if (x.to_binding_id !== desk) bad.push(`to=${x.to_binding_id}`);
    if (x.trigger !== 'silence') bad.push(`trigger=${x.trigger}`);
    return bad.length ? fail(bad.join('、')) : pass('恰好 1 条 TURING→DESK，trigger=silence');
  });
  checks.B2 = judge(() => {
    const x = theHandover(); if (!x) return fail('没有自动交接');
    const last = need(ms(x.holder_last_heartbeat_at), '回执 holder_last_heartbeat_at');
    const gap = ms(x.created_at) - last, [lo, hi] = RULES.silenceSeconds;
    return gap >= lo * 1000 && gap <= hi * 1000 ? pass(`最后心跳后 ${sec(gap)} 交接`) : fail(`最后心跳后 ${sec(gap)} 交接，不在 ${lo}–${hi} 秒`);
  });
  checks.B3 = judge(() => {
    const x = theHandover(); if (!x) return fail('没有自动交接');
    const lag = need(ms(x.effective_at), '回执 effective_at') - ms(x.created_at);
    if (lag < RULES.effectiveSeconds * 1000) return pass(`立即生效（${sec(lag)}）`);
    if (lag >= RULES.delayedEffectiveSeconds * 1000) return unknown(`相位不凑巧：${sec(lag)} 后才生效，查 ci_duty_answers_v1 里 TURING 最后答复后重做一次`);
    return fail(`生效延后 ${sec(lag)}`);
  });
  // 新持有生效之前 DESK 不可能当班，所以从交接与生效两者较晚的那个时刻起算 2 分钟。
  checks.B4 = judge(() => {
    const x = theHandover(); if (!x) return fail('没有自动交接');
    const anchor = Math.max(ms(x.created_at), ms(x.effective_at) ?? ms(x.created_at));
    const hit = pages().find(p => ms(p.observed_at) >= ms(x.created_at) && onlyHolder(p, desk)
      && nodeOf(p, desk)?.mode === 'ACTIVE' && nodeOf(p, desk)?.probe === 'held');
    if (hit) {
      const lag = ms(hit.observed_at) - anchor;
      return lag <= RULES.onDutySeconds * 1000 ? pass(`交接后 ${sec(Math.max(0, lag))} 读到 DESK 当班`) : fail(`交接后 ${sec(lag)} 才读到 DESK 当班`);
    }
    return lastObserved() >= anchor + RULES.onDutySeconds * 1000 ? fail('交接后 2 分钟内没读到 DESK 当班') : unknown('交接后 2 分钟的页没读到');
  });
  checks.B5 = judge(() => {
    const x = theHandover(); if (!x) return fail('没有自动交接');
    const rows = need(arr(d.dutyAnswers), 'dutyAnswers').filter(r => r?.binding_id === desk && ms(r.at) > ms(x.created_at));
    return rows.length ? pass(`DESK 交接后拿到当班答复（${rows.map(r => r.at).sort().at(-1)}）`) : fail('DESK 交接后没有当班答复');
  });
  checks.B6 = judge(() => {
    const back = restored(), until = back + RULES.standbyMinutes * 60_000;
    const hit = pages().find(p => {
      const o = ms(p.observed_at); if (o <= back || o > until) return false;
      const t = nodeOf(p, turing), k = nodeOf(p, desk);
      return t && ms(t.last_heartbeat_at) > back && t.mode === 'STANDBY' && t.probe === 'not-held' && t.state === 'NORMAL'
        && t.halt === null && t.service_running === true && t.ci_source_manifest_sha256 && t.ci_source_manifest_sha256 === k?.ci_source_manifest_sha256;
    });
    if (hit) return pass(`复网后 ${sec(ms(hit.observed_at) - back)} 读到 TURING 待命、NORMAL、Source 相同`);
    return lastObserved() >= until ? fail('复网后 10 分钟内没读到 TURING 待命且健康') : unknown('复网后 10 分钟的页没读到');
  });
  checks.B7 = judge(() => {
    const since = t0(), bad = [];
    const p = pages().filter(x => ms(x.observed_at) >= since);
    const alerts = [...p.flatMap(x => arr(x.alerts) ?? []), ...(arr(d.receipts) ?? []).map(r => ({ created_at: r?.created_at, ...(r?.metadata ?? {}) }))]
      .filter(a => ALERTS.includes(a?.receipt_kind) && ms(a.created_at) >= since);
    if (alerts.length) bad.push(`有 ${[...new Set(alerts.map(a => a.receipt_kind))].join('、')}`);
    for (const x of p) for (const [name, b] of [['TURING', turing], ['DESK', desk]]) {
      const n = nodeOf(x, b);
      if (n && (n.halt !== null || n.state === 'HALTED' || n.readable_state === 'HALTED')) { bad.push(`${name} ${x.observed_at} HALT`); break; }
    }
    const h = handovers();
    if (h.length > 1) bad.push(`自动交接 ${h.length} 条（被抢回）`);
    if (p.length && holdersOf(p.at(-1)).length > 1) bad.push('持有者不止一个');
    if (bad.length) return fail([...new Set(bad)].join('；'));
    return lastObserved() >= since + RULES.noTakeBackMinutes * 60_000 ? pass('没有双活、没有扣发、没有 HALT，到 T0+45 分钟没被抢回')
      : unknown('T0+45 分钟之后的页没读到');
  });
  const exclusionsIn = (from, to) => need(arr(d.exclusions), 'exclusions').filter(e => ms(e?.at) !== null && ms(e.at) > from && ms(e.at) <= to);
  checks.B8 = judge(() => {
    const back = restored(), e = exclusionsIn(back, back + RULES.excludedBeforeMinutes * 60_000);
    if (!e.length) return unknown('复网后 29 分钟内没读排除原因');
    return e.every(x => x.value === 'auto_handed_out') ? pass('复网后 29 分钟内 TURING 排除原因是 auto_handed_out')
      : fail(`排除原因 ${JSON.stringify(e.map(x => x.value))}`);
  });
  checks.B9 = judge(() => {
    const back = restored(), [lo, hi] = RULES.rejoinedMinutes, e = exclusionsIn(back + lo * 60_000 - 1, back + hi * 60_000);
    if (!e.length) return unknown('复网后 31–35 分钟没读排除原因');
    return e.every(x => x.value === null) ? pass('复网后 31–35 分钟 TURING 资格已自动恢复')
      : fail(`复网后 31–35 分钟排除原因仍是 ${JSON.stringify(e.map(x => x.value))}`);
  });
  checks.B10 = judge(() => {
    const c = need(cut, '结果文件'), bad = [];
    if (c.outcome !== 'CUT_DONE') bad.push(`outcome=${c.outcome}`);
    if (ms(c.t0) === null || ms(c.restoredAt) === null) bad.push('T0 或复网时刻没记');
    if (!Array.isArray(c.enableFailed) || c.enableFailed.length) bad.push(`没启用成的网卡 ${JSON.stringify(c.enableFailed)}`);
    if (c.connected !== true) bad.push('复网后不通');
    if (c.backstopRemoved !== true) bad.push('兜底任务没删');
    return bad.length ? fail(bad.join('；')) : pass('网卡全部恢复、连通、兜底任务已删');
  });
  checks.B11 = judge(() => {
    const a = selfcheckOf(need(obj(d.statusTuring), 'TURING status.json')), b = selfcheckOf(need(obj(d.statusDesk), 'DESK status.json'));
    return a === 'PASS' && b === 'PASS' ? pass('演练后两台 selfcheck 仍 PASS') : fail(`selfcheck TURING=${a} DESK=${b}`);
  });
  return { kind: 'drill', verdict: overall(checks), checks };
}
