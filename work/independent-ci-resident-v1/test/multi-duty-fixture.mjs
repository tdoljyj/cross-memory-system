import { TRAIN_EFFECTS } from '../../actions-hosted-migration/independent-ci-v1/src/merge-train-v2-contract.mjs';

export function multiDutyClock(start) {
  let now = start;
  return Object.freeze({
    now: () => now,
    advance(ms) {
      if (!Number.isSafeInteger(ms) || ms < 0) throw new RangeError('虚拟时钟只能向前推进整毫秒');
      return (now += ms);
    },
  });
}

export function multiDutyGitHub(clock) {
  const faults = new Map(), pending = new Map(), events = new Map(), effects = [], requests = [];
  function count(kind, subject, node = null) {
    if (!TRAIN_EFFECTS.includes(kind)) throw new TypeError('未登记的外部效果');
    effects.push({ kind, subject: structuredClone(subject), node, at: clock.now() });
  }
  function arm(operation, { delay = false, loseReply = false } = {}) {
    if (faults.has(operation) || pending.has(operation)) throw new Error('动作已有故障');
    faults.set(operation, { delay, loseReply });
  }
  async function write(operation, apply, committed) {
    const fault = faults.get(operation);
    faults.delete(operation);
    requests.push({ operation, at: clock.now() });
    if (fault?.delay) await new Promise(resolve => pending.set(operation, resolve));
    const response = await apply();
    const effect = committed?.(response);
    if (effect) count(...effect);
    if (fault?.loseReply) throw new Error('夹具在远端写入后丢弃回复');
    return response;
  }
  return Object.freeze({
    arm, write, count,
    waiting: operation => pending.has(operation),
    release(operation) {
      const resume = pending.get(operation);
      if (!resume) throw new Error('没有等待中的写');
      pending.delete(operation);
      resume();
    },
    emit(id, event) {
      if (events.has(id)) throw new Error('重复事件编号');
      events.set(id, structuredClone(event));
    },
    async deliver(id, receive) {
      if (!events.has(id)) throw new Error('没有此事件');
      const event = events.get(id);
      events.delete(id);
      await receive(event);
    },
    effects: () => structuredClone(effects),
    requests: () => structuredClone(requests),
    totals: () => Object.fromEntries(TRAIN_EFFECTS.map(kind => [kind, effects.filter(effect => effect.kind === kind).length])),
  });
}
