// Exact frozen contract literals; no local artifact/filesystem reader in Worker.
export const SCOPE = 'project:0597aa60-9b98-4da6-a4ab-63d7705b632f';
export const TASK = '1502fd80-8ff8-4adc-b4f5-da6d462f4f8a';
export const ALLOWED = Object.freeze(['LOCAL_FIXED_M1_REFERENCE_QUALIFICATION_INFERENCE', 'SAVE_ACTUAL_QUALIFICATION_OUTPUTS', 'DETERMINISTIC_SCORING_REPLAY_OF_SAVED_ACTUAL_OUTPUTS']);
export const PROHIBITED = Object.freeze(['WEIGHT_LEARNING', 'TRAINING', 'MODEL_SELECTION_OR_TUNING', 'QUALIFICATION_FEEDBACK_TO_SELECTION',
  'FINAL_HOLDOUT', 'PROTECTED48', 'PUBLIC_OR_SYNTHETIC_GENERATION', 'OLD_M1_T0_T1_PROFILE_REUSE', 'INSTALLATION', 'VM', 'PRODUCTION', 'RELEASE']);
export class ProfileNotReady extends Error { constructor(code) { super(code); this.code = code; } }
export const demand = (value, code) => { if (!value) throw new ProfileNotReady(code); };
export const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
export const same = (a, b) => {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') return exact(a, Object.keys(b)) && Object.keys(a).every(k => same(a[k], b[k]));
  return a === b;
};
const require = demand;
export const utc = value => {
  const m = typeof value === 'string' && /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,6}))?Z$/.exec(value);
  require(m, 'EXACT_UTC_TIME_REQUIRED');
  const numbers = m.slice(1, 7).map(Number), [y, month, day, h, minute, s] = numbers;
  const n = Date.UTC(y, month - 1, day, h, minute, s, Number((m[7] ?? '').padEnd(3, '0').slice(0, 3)));
  const date = new Date(n);
  require(Number.isFinite(n) && [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(),
    date.getUTCMinutes(), date.getUTCSeconds()].every((v, i) => v === numbers[i]), 'EXACT_UTC_TIME_REQUIRED'); return n;
};
