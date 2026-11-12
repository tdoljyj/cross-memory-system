// Read-only receipt consumer in the companion. The service cannot write the Owner's profile.
import { CODE } from './canonical.mjs';
import { ALERT_RECEIPT, REMINDER_RECEIPT } from './retention.mjs';
export class RetentionNotifier {
  constructor({ receipts, store, notify, reviewGenerations, clock = Date.now }) { Object.assign(this, { receipts, store, notify, reviewGenerations, clock }); }
  async step() {
    if (this.clock() - (this.lastRead ?? -Infinity) < 60000) return;
    const rows = await this.receipts.latest([ALERT_RECEIPT, REMINDER_RECEIPT], 64);
    for (const row of rows.reverse()) {
      const v = row.value, at = Date.parse(v?.at), b = v?.body;
      if (!Number.isFinite(at) || at > this.clock() || this.clock() - at > 86400000 || !b) continue;
      const alert = v.type === ALERT_RECEIPT && ['windows', 'linux', 'generations', 'settings', 'disk'].includes(b.spool) && CODE.test(b.code ?? '');
      const size = v.type === REMINDER_RECEIPT && Number.isSafeInteger(b.totalBytes) && b.totalBytes >= 0;
      if (!alert && !size) continue;
      const key = alert ? `retention:${b.spool}:${b.code}` : 'retention:size';
      if (this.clock() - Date.parse(this.store.data.notified[key]?.at ?? '') < 86400000) continue;
      await this.notify(key, alert ? 'Clued：归档保留需要检查' : 'Clued：归档空间需要检查', alert
        ? `${b.spool}: ${b.code}。请检查归档保留配置；未自动放宽清理条件。`
        : `归档共 ${Math.floor(b.totalBytes / 1024 ** 3)} GiB，请检查归档保留设置。`);
      this.store.data.notified[key] = { at: new Date(this.clock()).toISOString() };
      await this.store.save();
    }
    if (typeof this.reviewGenerations === 'function') {
      const result = await this.reviewGenerations();
      if (result?.code && CODE.test(result.code)) {
        const key = `retention:generations:${result.code}`;
        if (!(this.clock() - Date.parse(this.store.data.notified[key]?.at ?? '') < 86400000)) {
          await this.notify(key, 'Clued：旧代归档需要检查', `${result.code}。请检查旧代归档；清理需要已授权的维护身份，不会自动提权。`);
          this.store.data.notified[key] = { at: new Date(this.clock()).toISOString() }; await this.store.save();
        }
      }
    }
    this.lastRead = this.clock();
  }
}
