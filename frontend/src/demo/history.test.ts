import { describe, expect, it } from "vitest";

import { combine, DAY, HOUR, MINUTE, outages, overlap, percentile, sample, type Spec } from "./history";

const spec: Spec = { id: 3, baseLatency: 120, interval: 60, createdAt: 0, outageRate: 0.2 };
const now = Date.UTC(2026, 9, 17, 12, 30);

describe("percentile", () => {
  it("interpolates like PostgreSQL's percentile_cont", () => {
    // Same numbers as backend/tests/test_stats.py::test_latency_buckets.
    expect(percentile([100, 200, 900], 0.95)).toBeCloseTo(830);
    expect(percentile([100, 200, 900], 0.5)).toBe(200);
    expect(percentile([42], 0.95)).toBe(42);
    expect(percentile([], 0.95)).toBeNull();
  });
});

describe("procedural history", () => {
  it("is a pure function of time", () => {
    expect(outages(spec, now - 90 * DAY, now)).toEqual(outages(spec, now - 90 * DAY, now));
    const a = sample(spec, now - 3 * HOUR, now - 2 * HOUR, [], now);
    expect(sample(spec, now - 3 * HOUR, now - 2 * HOUR, [], now)).toEqual(a);
  });

  it("counts one check per interval and fails the ones inside an outage", () => {
    const outage = { id: 1, monitorId: 3, start: now - 50 * MINUTE, end: now - 40 * MINUTE, cause: "503" };
    const s = sample(spec, now - HOUR, now, [outage], now);
    expect(s.checks).toBe(60);
    expect(s.failures).toBe(10);
    expect(s.avg).toBeGreaterThan(0);
    expect(s.p95!).toBeGreaterThan(s.avg!);
  });

  it("has no data before the monitor existed", () => {
    const young = { ...spec, createdAt: now - HOUR };
    expect(sample(young, now - 3 * HOUR, now - 2 * HOUR, [], now).checks).toBe(0);
  });

  it("never schedules an outage across the end of the history", () => {
    for (const o of outages(spec, now - 90 * DAY, now)) expect(o.end!).toBeLessThan(now);
  });

  it("splits downtime at bucket edges", () => {
    const o = { id: 1, monitorId: 3, start: now - 15 * MINUTE, end: now + 15 * MINUTE, cause: "" };
    expect(overlap(now - HOUR, now, [o], now + HOUR)).toBe(15 * MINUTE);
  });

  it("combines buckets by summing counts and weighting latency", () => {
    const merged = combine([
      { checks: 10, failures: 0, avg: 100, p50: 90, p95: 150 },
      { checks: 10, failures: 10, avg: null, p50: null, p95: null },
      { checks: 30, failures: 0, avg: 200, p50: 180, p95: 300 },
    ]);
    expect(merged.checks).toBe(50);
    expect(merged.failures).toBe(10);
    expect(merged.avg).toBe(175);
  });
});
