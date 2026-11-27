// Advisory only: reads the stage-10 ci_nodes_status view and GitHub. Never installs, dispatches or alters a gate.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const HEX40 = /^[a-f0-9]{40}$/;
export const FLEET_LAG_MS = 12 * 3600000;
export const FLEET_ALERT_EVERY_MS = 10 * 60000;
export const NODE_PATHS = ['work/independent-ci-resident-v1/', 'work/actions-hosted-migration/independent-ci-v1/'];
const relevant = c => HEX40.test(c?.sha ?? '') && Number.isFinite(c.at) && c.paths?.some(p => NODE_PATHS.some(prefix => p.startsWith(prefix)));

export function fleetLagEvents({ now, changes = [], fleet, sources = new Map(), contains, blocker = '阻塞原因未知' }) {
  if (!fleet || !fleet.nodes?.length || !Number.isFinite(Date.parse(fleet.at)) || now < Date.parse(fleet.at) || now - Date.parse(fleet.at) > 30 * 60000) {
    const overdue = changes.filter(relevant).find(c => now - c.at >= FLEET_LAG_MS);
    return overdue ? [{ key: `fleet-lag:unreadable:${overdue.sha}`, title: '节点更新核验不可用',
      body: `全队 ci_nodes_status 视图缺失、过期或时钟异常，无法确认全部节点安装情况；main 改动 ${overdue.sha} 已超过 12 小时。阻塞原因：FLEET_STATUS_UNREADABLE。未核验已接受包。` }] : [];
  }
  const out = [];
  for (const change of changes.filter(relevant).filter(c => now - c.at >= FLEET_LAG_MS)) {
    const missing = [], unknown = [];
    for (const node of fleet.nodes ?? []) {
      const source = sources.get(node.sourceManifestSha256);
      if (source?.sha && contains) {
        const included = contains(change.sha, source.sha);
        if (included === true) continue;
        if (included !== false) { unknown.push(node.node ?? '未命名节点'); continue; }
      } else if (Number.isFinite(source?.at)) {
        if (source.at >= change.at) continue;
      } else { unknown.push(node.node ?? '未命名节点'); continue; }
      missing.push(node.node ?? '未命名节点');
    }
    if (!missing.length && !unknown.length && !fleet.dropped) continue;
    const qualified = '按 main 时间与 Source 生成时间/提交祖先关系判断；未核验已接受包';
    const body = `${missing.length ? `落后节点：${missing.join('、')}。` : ''}${unknown.length ? `Source 无法核验：${unknown.join('、')}（不能视为已安装）。` : ''}`
      + `${fleet.dropped ? `节点表截断 ${fleet.dropped} 项。` : ''}缺的改动/待核验改动：${change.sha} ${change.paths.join('、')}，main 观察/提交时间 ${new Date(change.at).toISOString()}。阻塞原因：${blocker}。${qualified}。`;
    // Once per change and affected fleet, across restarts. A newly lagging node gets its own episode.
    const identity = `${change.sha}:${[...missing.map(n => `lag:${n}`), ...unknown.map(n => `unknown:${n}`)].sort().join(',')}:${fleet.dropped ?? 0}`;
    out.push({ key: `fleet-lag:${createHash('sha256').update(identity).digest('hex')}`, title: missing.length ? '节点相关改动超过 12 小时未装齐' : '节点更新超过 12 小时待核验', body });
  }
  return out;
}

export class FleetLagNotifier {
  constructor(ports) { Object.assign(this, ports); }
  async step() {
    const now = this.clock();
    if (now - (this.lastRead ?? -Infinity) < FLEET_ALERT_EVERY_MS) return;
    this.lastRead = now;
    try {
      const input = await this.read();
      for (const event of fleetLagEvents({ ...input, now })) {
        if (this.store.data.notified[event.key]) continue;
        await this.notify(event.key, event.title, event.body);
        this.store.data.notified[event.key] = { at: new Date(now).toISOString() };
        try { await this.store.save(); } catch (error) { delete this.store.data.notified[event.key]; throw error; }
      }
    } catch { /* auxiliary lane: no failure can affect CI or count as delivered */ }
  }
}

// Bounded reads, pinned to one main SHA. Each path's most recent 100 entries; truncation stays explicit.
export function githubFleetChanges({ ghExe, repo, run }) {
  const api = async endpoint => {
    const r = await run([ghExe, 'api', `repos/${repo}/${endpoint}`], { timeoutMs: 15000, maxOutput: 2 * 1024 * 1024 });
    if ((r.exitCode ?? r.code) !== 0 || r.timedOut || r.refused || Buffer.byteLength(r.stdout ?? '') > 2 * 1024 * 1024) throw Error('FLEET_MAIN_UNREADABLE');
    return JSON.parse(r.stdout);
  };
  const read = async () => {
    const tip = await api('commits/main');
    if (!HEX40.test(tip.sha ?? '')) throw Error('FLEET_MAIN_UNREADABLE');
    const changes = new Map(); let truncated = false;
    for (const prefix of NODE_PATHS) {
      const list = await api(`commits?sha=${tip.sha}&path=${encodeURIComponent(prefix)}&per_page=100`);
      if (!Array.isArray(list)) throw Error('FLEET_HISTORY_UNREADABLE');
      truncated ||= list.length >= 100;
      for (const c of list) {
        if (!HEX40.test(c.sha ?? '')) continue;
        const existing = changes.get(c.sha) ?? { sha: c.sha, at: Date.parse(c.commit?.committer?.date), paths: [] };
        existing.paths.push(prefix); changes.set(c.sha, existing);
      }
    }
    return { changes: [...changes.values()], mainSha: tip.sha, truncated };
  };
  read.api = api;
  return read;
}

// Only the installed record is locally available. Other Source hashes remain unknown, visibly alerted after 12h;
// a different digest alone is never evidence of an older Source. No acceptance or upgrader state is fabricated.
export function fleetLagReader({ root, readStatus, github, clock = Date.now, readFile = fs.readFile, observationStore = null }) {
  return async () => {
    let status = null;
    try { status = await readStatus(); } catch { /* unreadable fleet remains unknown and gets its advisory */ }
    const fleet = status?.train?.nodes;
    if (fleet && Object.hasOwn(fleet, 'holderPackage')) return { changes: [], fleet };
    const result = await github();
    // Committer time can predate the merge. First seeing the exact commit reachable from main is an upper bound
    // on its merge time: wait a full 12h from that bound, persisted across restart, never alert early for an old head.
    if (observationStore) {
      let dirty = false;
      result.changes = result.changes.map(change => {
        const key = `fleet-main-seen:${change.sha}`;
        let first = Date.parse(observationStore.data.notified[key]?.at ?? '');
        if (!Number.isFinite(first) || first > clock()) {
          first = clock(); observationStore.data.notified[key] = { at: new Date(first).toISOString() }; dirty = true;
        }
        return { ...change, at: Math.max(change.at, first) };
      });
      if (dirty) await observationStore.save();
    }
    if (!fleet || clock() - Date.parse(fleet.at) > 30 * 60000) return { ...result, fleet };
    const sources = new Map(), relations = new Map();
    try {
      const bytes = await readFile(path.join(root, 'record', 'source-manifest.json'));
      const hash = createHash('sha256').update(bytes).digest('hex');
      const manifest = JSON.parse(bytes);
      if (HEX40.test(manifest.sourceSha ?? '')) {
        const commit = await github.api(`commits/${manifest.sourceSha}`);
        sources.set(hash, { sha: manifest.sourceSha, at: Date.parse(commit.commit?.committer?.date) });
        const compared = await github.api(`compare/${manifest.sourceSha}...${result.mainSha}`);
        const missing = new Set((compared.commits ?? []).map(c => c.sha));
        for (const change of result.changes.filter(relevant)) {
          const included = ['identical', 'behind'].includes(compared.status) || change.sha === manifest.sourceSha ? true
            : missing.has(change.sha) ? false
              : compared.status === 'ahead' && compared.total_commits <= (compared.commits?.length ?? 0) ? true : null;
          relations.set(`${change.sha}:${manifest.sourceSha}`, included);
        }
      }
    } catch { /* unknown Sources are reported, never guessed from digest order */ }
    const blocker = status.versions?.upgrade?.code ?? status.train?.last?.decision ?? '阻塞原因未知';
    return { ...result, fleet, sources, contains: (a, b) => relations.get(`${a}:${b}`) ?? null,
      blocker: `${blocker}${result.truncated ? '；main 历史仅最近每路径 100 项' : ''}` };
  };
}
