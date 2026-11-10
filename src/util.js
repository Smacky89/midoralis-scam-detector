// Small shared helpers: durations, text truncation, a concurrency limiter.

const UNITS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

// "10m", "1h30m", "2d", "1w", "45s", or a bare number of minutes → ms.
// Returns null if it can't be parsed.
export function parseDuration(input) {
  if (input == null) return null;
  const str = String(input).trim().toLowerCase();
  if (!str) return null;
  if (/^\d+$/.test(str)) return Number(str) * UNITS.m;
  const re = /(\d+)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|wk|weeks?)/g;
  let total = 0;
  let consumed = '';
  let m;
  while ((m = re.exec(str)) !== null) {
    total += Number(m[1]) * UNITS[m[2][0]];
    consumed += m[0];
  }
  if (!total || consumed.replace(/\s/g, '') !== str.replace(/\s/g, '')) return null;
  return total;
}

export function formatDuration(ms) {
  if (!ms || ms < 1000) return '0s';
  const parts = [];
  for (const [unit, size] of [['w', UNITS.w], ['d', UNITS.d], ['h', UNITS.h], ['m', UNITS.m], ['s', UNITS.s]]) {
    if (ms >= size) {
      parts.push(`${Math.floor(ms / size)}${unit}`);
      ms %= size;
    }
  }
  return parts.slice(0, 2).join(' ');
}

export const truncate = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

// Limits how many async jobs run at once; extra jobs wait in a queue.
export function createLimiter(concurrency) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => {
      active--;
      next();
    });
  };
  const limit = (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
  Object.defineProperty(limit, 'pending', { get: () => queue.length + active });
  return limit;
}

export function withTimeout(promise, ms, label = 'operation') {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Tiny LRU set used to remember recently-seen clean image hashes.
export class LruSet {
  constructor(max) {
    this.max = max;
    this.map = new Map();
  }
  has(key) {
    if (!this.map.has(key)) return false;
    this.map.delete(key);
    this.map.set(key, true);
    return true;
  }
  add(key) {
    this.map.delete(key);
    this.map.set(key, true);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  delete(key) {
    this.map.delete(key);
  }
}
