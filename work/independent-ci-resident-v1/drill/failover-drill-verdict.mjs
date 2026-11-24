// 第 18 代故障转移演练的判定（任务 04f9b91b；方案 D:/w/tmp/PLAN-failover-drill-gen18-20261124.md 第 4、6 节，
// 定案 D:/w/tmp/PLAN-failover-drill-gen18-addendum-20261124.md，独立复核 D:/w/tmp/claude-review-failover-drill-gen18-fable.md）。
// 纯函数：不联网、不读写文件。输入由编排入口（failover-drill.mjs 的 gateInputFrom、drillInputFrom）从快照与读数拼好，输出逐条的过或不过和原因：
//   ok: true 过；false 不过；null 未判定（读不到、读数不新鲜、窗口没读到，或 B3 的“相位不凑巧”）。
// 总判：有一条 false 即 FAIL；否则有一条 null 即 UNDETERMINED；全 true 才 PASS。读不到永远不判 PASS。
//
// gateVerdict(input) 放行前 A0–A7、I1–I5：
//   { now,                     入口跑门的时刻（毫秒或 ISO）
//     turing, desk,            两台的 CI 连接 binding_id
//     source,                  第 18 代的 Source（--source，64 位十六进制，取自接受文件）
//     snapshotAt,              快照的服务器时刻（server_time）
//     page,                    快照里的 page（与 public.clued_resident_failover_v1 同形，少 connections、bindings）
//     candidates,              快照里的 candidates（ci_failover_candidates_v1(owner, turing, turing 的 Source, null, now())）
//     statusTuring, statusDesk, 两台本机 C:\ProgramData\CluedIndependentCI\resident\state\status.json
//     idle: { runsInProgress, runsQueued,   gh run list --status in_progress|queued --limit 50 --json databaseId,name,status,createdAt,event
//             prs,                          gh pr list --state open --limit 100 --json number,isDraft,statusCheckRollup
//             shadow,                       node scripts/ci/shadow-compare.mjs --prs <起点>- 的输出（counts 等在 summary 下）
//             vms } }                       DESK 本机 Get-VM 的 [{ Name, State }]
// drillVerdict(input) 演练后 B1–B11：
//   { turing, desk,
//     cut,                     TURING 上断网脚本的结果文件（failover-drill-<id>.result.json）
//     pages,                   各次快照的 page（每个带 observed_at＝服务器时刻）
//     receipts,                各次快照 receipts 的并集，按 id 去重 [{ id, created_at, operation, metadata }]
//     dutyAnswers,             各次快照 duty_answers 的并集 [{ binding_id, at }]
//     exclusions,              每个快照一条 { at: server_time, exclusion: TURING 的排除原因, steadySince: TURING 的 steady_since }
//     statusTuring, statusDesk } 演练后两台 status.json
export const RULES = Object.freeze({
  freshSeconds: 120,                 // A0：快照与两台 status.json 距跑门不超过 2 分钟
  heartbeatFreshSeconds: 120,        // A3、A4：心跳 2 分钟内
  rules: Object.freeze({ silence_minutes: 5, unhealthy_minutes: 5, rejoin_steady_minutes: 30 }), // A6：5/5/30
  silenceSeconds: [300, 390],        // B2：交接 − 最后心跳在 5 分 00 秒到 6 分 30 秒
  effectiveSeconds: 10,              // B3：立即生效
  delayedEffectiveSeconds: 290,      // B3：延后（5 分钟）生效判“相位不凑巧”
  onDutySeconds: 120,                // B4：交接与生效较晚者之后 2 分钟内 DESK 有当班答复
  standbyMinutes: 10,                // B6：steady_since 不晚于复网 + 10 分钟
  noTakeBackMinutes: 45,             // B7：到 T0+45 分钟没有第 2 条自动交接
  excludedBeforeMinutes: 29,         // B8：steady_since + 29 分钟以前仍 auto_handed_out
  rejoinedMinutes: Object.freeze([31, 40]), // B9：steady_since + 31–40 分钟已恢复（null）
  runEvents: Object.freeze(['pull_request', 'pull_request_target', 'push']), // I1：只数这几种触发的运行
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

const lastOf = list => (list.length ? list.at(-1) : null);
const ageProblem = (name, iso, now) => {
  const t = ms(iso);
  if (t === null) return `${name} 没有时刻`;
  const age = now - t;
  return age > RULES.freshSeconds * 1000 || age < -RULES.freshSeconds * 1000 ? `${name} ${iso} 距跑门 ${sec(age)}` : null;
};

// ---------------------------------------------------------------------------
// 放行前
export function gateVerdict(input) {
  const g = obj(input) ?? {};
  const { turing, desk, page, source } = g;
  const idle = obj(g.idle) ?? {};
  const checks = {};
  const observed = () => need(ms(page?.observed_at), 'page.observed_at');

  // 读数新鲜：拿旧快照或旧 status.json 重跑不放行（复核 M3）。不新鲜判未判定，不判不过。
  checks.A0 = judge(() => {
    const now = typeof g.now === 'number' ? g.now : need(ms(g.now), 'now（跑门时刻）');
    const st = need(obj(g.statusTuring), 'TURING status.json'), sd = need(obj(g.statusDesk), 'DESK status.json');
    const stale = [ageProblem('快照', g.snapshotAt ?? page?.observed_at, now), ageProblem('TURING status.json', st.writtenAt, now),
      ageProblem('DESK status.json', sd.writtenAt, now)].filter(Boolean);
    return stale.length ? unknown(`读数不新鲜（超过 ${RULES.freshSeconds} 秒）：${stale.join('；')}`) : pass('快照与两台 status.json 都是 2 分钟内的');
  });
  checks.A1 = judge(() => {
    const want = need(typeof source === 'string' && /^[0-9a-f]{64}$/.test(source) ? source : null, '--source');
    const st = need(obj(g.statusTuring), 'TURING status.json'), sd = need(obj(g.statusDesk), 'DESK status.json');
    const bad = [];
    for (const [name, s] of [['TURING', st], ['DESK', sd]]) {
      if (selfcheckOf(s) !== 'PASS') bad.push(`${name} selfcheck=${selfcheckOf(s)}`);
      if (s.versions?.consistent !== true) bad.push(`${name} versions.consistent=${s.versions?.consistent}`);
      const local = s.versions?.windows?.ciSourceManifestSha256;
      if (local !== want) bad.push(`${name} 本机 Source ${local ?? '无'}`);
    }
    for (const [name, b] of [['TURING', turing], ['DESK', desk]]) {
      const reported = nodeOf(page, b)?.ci_source_manifest_sha256;
      if (reported !== want) bad.push(`${name} 上报 Source ${reported ?? '无'}`);
    }
    return bad.length ? fail(`不是给定的 Source ${want.slice(0, 12)}：${bad.join('；')}`) : pass(`两台 selfcheck PASS、版本一致，本机与上报的 Source 都是 ${want.slice(0, 12)}`);
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

  // 只数 PR 与 push 触发的运行；定时、手动触发的（面板、front 合并等）不产生 head 上的必需结论（定案 E3）。
  checks.I1 = judge(() => {
    const counted = list => list.filter(r => RULES.runEvents.includes(need(r?.event, `运行 ${r?.databaseId} 的 event`)));
    const a = counted(need(arr(idle.runsInProgress), 'runsInProgress')), b = counted(need(arr(idle.runsQueued), 'runsQueued'));
    return a.length + b.length === 0 ? pass('没有 PR 或 push 触发的排队、在跑运行')
      : fail(`PR/push 运行在跑 ${a.length}、排队 ${b.length}（${[...a, ...b].map(r => `${r.name}#${r.databaseId}`).join('、')}）`);
  });
  // 只看未完成的 CheckRun；StatusContext 不看（常驻的 resident-queue/<节点> (info only) 一直是 PENDING，定案 E1）。
  checks.I2 = judge(() => {
    const open = need(arr(idle.prs), 'prs').filter(p => p && p.isDraft !== true);
    const busy = open.filter(p => need(arr(p.statusCheckRollup), `#${p.number} statusCheckRollup`).some(c =>
      c?.__typename === 'CheckRun' && c.status !== 'COMPLETED'));
    return busy.length ? fail(`有未完成检查的 PR：${busy.map(p => `#${p.number}`).join('、')}`) : pass('open 非草稿 PR 的 CheckRun 都已完成');
  });
  checks.I3 = judge(() => {
    const s = need(obj(idle.shadow), 'shadow');
    if (s.status === 'error') return unknown(`影子对比读取失败：${s.error ?? ''}`);
    const summary = need(obj(s.summary), 'shadow.summary');
    const running = need(obj(summary.counts), 'shadow.summary.counts')['在跑'] ?? 0;
    const pending = need(summary.pendingMergedHeads, 'shadow.summary.pendingMergedHeads');
    return running === 0 && pending === 0 ? pass('影子对比在跑 0、已合入未出结论 0') : fail(`影子对比在跑 ${running}、已合入未出结论 ${pending}`);
  });
  // 当班节点 TURING 的 status.json：current 是在途批次，queue.live 是执行器自己数的在排行数；pending 是展示用的行表，不数（定案第 5 条）。
  checks.I4 = judge(() => {
    const s = need(obj(g.statusTuring), 'TURING status.json');
    if (!('current' in s)) throw new Error('缺 TURING current');
    const live = need(obj(s.queue), 'TURING queue').live;
    if (typeof live !== 'number') throw new Error('缺 TURING queue.live');
    return s.current === null && live === 0 ? pass('TURING 没有在途批次、在排 0')
      : fail(`TURING 在途 ${s.current ? `#${s.current.pr}` : '无'}、在排 ${live}`);
  });
  checks.I5 = judge(() => {
    const on = need(arr(idle.vms), 'vms').filter(v => v?.State === 'Running' || v?.State === 2);
    return on.length ? fail(`DESK 上有虚拟机开着：${on.map(v => v.Name).join('、')}`) : pass('DESK 上没有虚拟机开着');
  });
  const idleChecks = ['I1', 'I2', 'I3', 'I4', 'I5'].map(k => checks[k]);
  checks.A7 = idleChecks.some(c => c.ok === false) ? fail('列车不空闲（见 I1–I5）')
    : idleChecks.some(c => c.ok !== true) ? unknown('空闲判据有读不到的（见 I1–I5）') : pass('列车空闲（I1–I5）');
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
  const lastPage = () => lastOf(pages());
  const lastObserved = () => { const p = lastPage(); return p ? ms(p.observed_at) : -Infinity; };
  const exclusions = () => need(arr(d.exclusions), 'exclusions').filter(e => ms(e?.at) !== null).sort((a, b) => ms(a.at) - ms(b.at));
  // TURING 本轮“连续健康”的起点：取末次快照上的 steady_since（其间不健康过会被清空重起）。
  const steadySince = () => {
    const last = lastOf(exclusions());
    if (!last) return null;
    return ms(last.steadySince);
  };
  // 自动交接：库里的回执与各页 alerts 取并集，按回执 id 去重（复核 M4：回执早读、页上后来出现的第 2 条也要算）。
  const handovers = () => {
    const since = t0();
    const rows = arr(d.receipts), pageAlerts = arr(d.pages)?.filter(p => arr(p?.alerts)) ?? [];
    if (!rows && !pageAlerts.length) throw new Error('缺回执与页 alerts');
    const byKey = new Map();
    const keyOf = x => x.id ?? `${x.created_at}|${x.from_binding_id}|${x.to_binding_id}`;
    for (const p of pageAlerts) for (const a of p.alerts) {
      if (a?.receipt_kind !== AUTO || !(ms(a.created_at) >= since)) continue;
      const x = { ...a, id: a.receipt_id ?? null };
      if (!byKey.has(keyOf(x))) byKey.set(keyOf(x), x);
    }
    for (const r of rows ?? []) {
      if (r?.metadata?.receipt_kind !== AUTO || !(ms(r.created_at) >= since)) continue;
      const x = { id: r.id ?? null, created_at: r.created_at, ...r.metadata };
      byKey.set(keyOf(x), { ...(byKey.get(keyOf(x)) ?? {}), ...x });
    }
    return [...byKey.values()].sort((a, b) => ms(a.created_at) - ms(b.created_at));
  };
  const theHandover = () => handovers()[0] ?? null;
  const anchorOf = x => Math.max(ms(x.created_at), ms(x.effective_at) ?? ms(x.created_at));
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
  // 新持有生效之前 DESK 不可能当班，所以从交接与生效两者较晚的那个时刻起算 2 分钟（定案第 8 条）；证据是 DESK 的当班答复（服务器时刻），
  // 外加末次快照里 DESK 是 ACTIVE、held、唯一持有者（定案第 2 条第 5 点）。
  checks.B4 = judge(() => {
    const x = theHandover(); if (!x) return fail('没有自动交接');
    const anchor = anchorOf(x), limit = anchor + RULES.onDutySeconds * 1000;
    const last = lastPage();
    if (!last) return unknown('末次快照没读到');
    const first = need(arr(d.dutyAnswers), 'dutyAnswers').filter(r => r?.binding_id === desk && ms(r.at) > ms(x.created_at))
      .sort((a, b) => ms(a.at) - ms(b.at))[0];
    if (!first) return lastObserved() >= limit ? fail('交接后 DESK 没有当班答复') : unknown('交接后 2 分钟的快照没读到');
    const lag = ms(first.at) - anchor;
    if (lag > RULES.onDutySeconds * 1000) return fail(`DESK 第一条当班答复在起算点后 ${sec(lag)}，超过 ${RULES.onDutySeconds} 秒`);
    if (ms(last.observed_at) < limit) return unknown('末次快照早于起算点 + 2 分钟');
    const n = nodeOf(last, desk);
    if (!(onlyHolder(last, desk) && n?.mode === 'ACTIVE' && n?.probe === 'held')) {
      return fail(`末次快照里 DESK 不是唯一当班持有者（持有者 ${JSON.stringify(holdersOf(last).map(h => h?.binding_id))}，mode=${n?.mode}、probe=${n?.probe}）`);
    }
    return pass(`DESK 在起算点后 ${sec(Math.max(0, lag))} 答复当班，末次快照里是唯一持有者`);
  });
  checks.B5 = judge(() => {
    const x = theHandover(); if (!x) return fail('没有自动交接');
    const rows = need(arr(d.dutyAnswers), 'dutyAnswers').filter(r => r?.binding_id === desk && ms(r.at) > ms(x.created_at));
    return rows.length ? pass(`DESK 交接后拿到当班答复（${rows.map(r => r.at).sort().at(-1)}）`) : fail('DESK 交接后没有当班答复');
  });
  // steady_since 晚于交接、不晚于复网 + 10 分钟，且末次快照里 TURING 待命、健康、Source 与 DESK 相同（定案第 2 条第 5 点）。
  checks.B6 = judge(() => {
    const x = theHandover(); if (!x) return fail('没有自动交接');
    const until = restored() + RULES.standbyMinutes * 60_000;
    const lastEx = lastOf(exclusions()), last = lastPage();
    if (!lastEx || !last) return unknown('末次快照没读到');
    const steady = steadySince();
    if (steady === null) return ms(lastEx.at) >= until ? fail('复网后 10 分钟 TURING 的 steady_since 仍为空') : unknown('steady_since 还没有，复网后 10 分钟的快照没读到');
    if (steady <= ms(x.created_at)) return fail(`steady_since ${lastEx.steadySince} 不晚于交接`);
    if (steady > until) return fail(`steady_since ${lastEx.steadySince} 晚于复网 + 10 分钟`);
    const t = nodeOf(last, turing), k = nodeOf(last, desk), bad = [];
    if (!t) bad.push('没有 TURING');
    else {
      for (const [key, v] of Object.entries({ mode: 'STANDBY', probe: 'not-held', state: 'NORMAL', halt: null, service_running: true })) if (t[key] !== v) bad.push(`${key}=${JSON.stringify(t[key])}`);
      if (!t.ci_source_manifest_sha256 || t.ci_source_manifest_sha256 !== k?.ci_source_manifest_sha256) bad.push('Source 与 DESK 不同');
    }
    return bad.length ? fail(`末次快照里 TURING：${bad.join('、')}`) : pass(`复网后 ${sec(steady - restored())} 连续健康起算，末次快照里 TURING 待命、NORMAL、Source 相同`);
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
      : unknown('T0+45 分钟之后的快照没读到');
  });
  // B8、B9 锚在 TURING 的 steady_since（服务器时刻），资格恢复的 30 分钟从它起算（定案第 9 条）。
  checks.B8 = judge(() => {
    const steady = steadySince(); if (steady === null) return unknown('没读到 steady_since');
    const x = theHandover(); if (!x) return fail('没有自动交接');
    const e = exclusions().filter(v => ms(v.at) > ms(x.created_at) && ms(v.at) < steady + RULES.excludedBeforeMinutes * 60_000);
    if (!e.length) return unknown('交接后、steady_since + 29 分钟前没有快照');
    return e.every(v => v.exclusion === 'auto_handed_out') ? pass(`交接后到 steady_since + 29 分钟的 ${e.length} 个快照里 TURING 都是 auto_handed_out`)
      : fail(`排除原因 ${JSON.stringify(e.map(v => v.exclusion))}`);
  });
  checks.B9 = judge(() => {
    const steady = steadySince(); if (steady === null) return unknown('没读到 steady_since');
    const [lo, hi] = RULES.rejoinedMinutes;
    const e = exclusions().filter(v => ms(v.at) >= steady + lo * 60_000 && ms(v.at) <= steady + hi * 60_000);
    if (!e.length) return unknown(`steady_since + ${lo}–${hi} 分钟没有快照`);
    return e.every(v => v.exclusion === null) ? pass(`steady_since + ${lo}–${hi} 分钟 TURING 资格已自动恢复`)
      : fail(`steady_since + ${lo}–${hi} 分钟排除原因仍是 ${JSON.stringify(e.map(v => v.exclusion))}`);
  });
  checks.B10 = judge(() => {
    const c = need(cut, '结果文件'), bad = [];
    if (c.outcome !== 'CUT_DONE') bad.push(`outcome=${c.outcome}`);
    if (ms(c.t0) === null || ms(c.restoredAt) === null) bad.push('T0 或复网时刻没记');
    if (!Array.isArray(c.enableFailed) || c.enableFailed.length) bad.push(`没启用成的网卡 ${JSON.stringify(c.enableFailed)}`);
    if (c.connected !== true) bad.push('复网后不通');
    if (c.backstopRemoved !== true) bad.push('兜底任务没删');
    return bad.length ? fail(bad.join('；')) : pass('网卡全部读回已启用、连通、兜底任务已删');
  });
  checks.B11 = judge(() => {
    const a = selfcheckOf(need(obj(d.statusTuring), 'TURING status.json')), b = selfcheckOf(need(obj(d.statusDesk), 'DESK status.json'));
    return a === 'PASS' && b === 'PASS' ? pass('演练后两台 selfcheck 仍 PASS') : fail(`selfcheck TURING=${a} DESK=${b}`);
  });
  return { kind: 'drill', verdict: overall(checks), checks };
}
