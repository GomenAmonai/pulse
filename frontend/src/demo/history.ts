// Procedural history for the demo: 90 days of checks per monitor without storing any of
// them. Every number is a pure function of (monitor, time), so the same bucket always
// gives the same answer, across reloads and across chart ranges.

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export interface Spec {
  id: number;
  baseLatency: number;
  interval: number; // seconds
  createdAt: number; // ms
  /** Chance that a given UTC day had an outage. */
  outageRate: number;
}

export interface Outage {
  id: number;
  monitorId: number;
  start: number;
  end: number | null;
  cause: string;
}

export interface Sample {
  checks: number;
  failures: number;
  avg: number | null;
  p50: number | null;
  p95: number | null;
}

/** Deterministic hash of two integers to [0, 1). */
export function noise(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(Math.floor(b) | 0, 0xc2b2ae35) ^ Math.floor(b / 4294967296);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const CAUSES = ["Expected HTTP 200, got 503", "Timed out after 10s", "Expected HTTP 200, got 502", "Connection failed: connection refused"];

/** Outages before `until`, one at most per UTC day, at a stable time of day. */
export function outages(spec: Spec, from: number, until: number): Outage[] {
  const result: Outage[] = [];
  for (let dayIndex = Math.floor(from / DAY); dayIndex <= Math.floor(until / DAY); dayIndex++) {
    if (noise(spec.id * 31 + 7, dayIndex) >= spec.outageRate) continue;
    const start = dayIndex * DAY + Math.floor(noise(spec.id, dayIndex * 3 + 1) * (DAY - 2 * HOUR));
    const minutes = [3, 6, 11, 18, 27, 44][Math.floor(noise(spec.id, dayIndex * 3 + 2) * 6)];
    const end = start + minutes * MINUTE;
    if (start < spec.createdAt || end >= until) continue;
    result.push({
      id: spec.id * 100_000 + dayIndex,
      monitorId: spec.id,
      start,
      end,
      cause: CAUSES[Math.floor(noise(spec.id, dayIndex * 7) * CAUSES.length)],
    });
  }
  return result;
}

export function overlap(start: number, end: number, outagesList: Outage[], now: number): number {
  let total = 0;
  for (const o of outagesList) {
    const s = Math.max(start, o.start);
    const e = Math.min(end, o.end ?? now);
    if (e > s) total += e - s;
  }
  return total;
}

/** Typical latency at a moment: a daily rhythm plus a day-to-day drift. */
export function typicalLatency(spec: Spec, t: number): number {
  const hourOfDay = (t % DAY) / HOUR;
  const daily = 1 + 0.18 * Math.sin(((hourOfDay - 9) / 24) * 2 * Math.PI);
  const drift = 0.88 + 0.24 * noise(spec.id + 101, Math.floor(t / DAY));
  return spec.baseLatency * daily * drift;
}

export function checkLatency(spec: Spec, t: number): number {
  const r = noise(spec.id + 17, Math.floor(t / SECOND));
  const spike = r > 0.985 ? 2.5 + r * 4 : 1;
  return Math.max(4, Math.round(typicalLatency(spec, t) * (0.75 + 0.5 * noise(spec.id + 3, Math.floor(t / SECOND))) * spike));
}

/** Aggregate of the procedural checks in [start, end). */
export function sample(spec: Spec, start: number, end: number, outagesList: Outage[], now: number): Sample {
  const from = Math.max(start, spec.createdAt);
  if (end <= from) return { checks: 0, failures: 0, avg: null, p50: null, p95: null };
  const checks = Math.max(0, Math.floor((end - from) / (spec.interval * SECOND)));
  if (checks === 0) return { checks: 0, failures: 0, avg: null, p50: null, p95: null };
  let failures = Math.round(overlap(from, end, outagesList, now) / (spec.interval * SECOND));
  // The odd single dropped check that flap protection exists for.
  if (failures === 0 && noise(spec.id + 5, Math.floor(start / MINUTE)) < 0.00004 * checks) failures = 1;
  failures = Math.min(failures, checks);
  if (failures === checks) return { checks, failures, avg: null, p50: null, p95: null };
  const avg = typicalLatency(spec, (from + end) / 2) * (0.94 + 0.12 * noise(spec.id + 9, Math.floor(start / MINUTE)));
  const tail = 1.45 + 0.7 * noise(spec.id + 13, Math.floor(start / MINUTE));
  return { checks, failures, avg, p50: avg * 0.92, p95: avg * tail };
}

/** Combine samples: counts add up, latency is weighted by successful checks. */
export function combine(parts: Sample[]): Sample {
  let checks = 0;
  let failures = 0;
  let weight = 0;
  let avg = 0;
  let p50 = 0;
  const p95s: number[] = [];
  for (const part of parts) {
    checks += part.checks;
    failures += part.failures;
    const ok = part.checks - part.failures;
    if (part.avg != null && ok > 0) {
      weight += ok;
      avg += part.avg * ok;
      p50 += (part.p50 ?? part.avg) * ok;
      p95s.push(part.p95 ?? part.avg);
    }
  }
  if (weight === 0) return { checks, failures, avg: null, p50: null, p95: null };
  return { checks, failures, avg: avg / weight, p50: p50 / weight, p95: percentile(p95s, 0.95) };
}

/** Same interpolation as PostgreSQL's percentile_cont. */
export function percentile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = q * (sorted.length - 1);
  const low = Math.floor(position);
  const high = Math.min(low + 1, sorted.length - 1);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}
