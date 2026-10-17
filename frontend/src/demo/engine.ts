// In-browser stand-in for the FastAPI backend, used on the static GitHub Pages build.
// It follows the real contract: same URLs, payloads, status codes and error codes, and a
// simulated worker that checks monitors on their interval, runs the same flap-protection
// state machine (flapping.ts) and pushes the same live events as /api/stream.
// History before page load is procedural (history.ts); configuration lives in localStorage.

import { ApiError } from "../lib/errors";
import type {
  Channel,
  Check,
  Day,
  Incident,
  LatencyPoint,
  LiveEvent,
  Monitor,
  MonitorStatus,
  Overall,
  PublicStatus,
  RangeKey,
  StatusPage,
  Window,
} from "../lib/types";
import { step } from "./flapping";
import {
  checkLatency,
  combine,
  DAY,
  HOUR,
  MINUTE,
  noise,
  outages,
  overlap,
  percentile,
  sample,
  SECOND,
  type Outage,
  type Sample,
  type Spec,
} from "./history";

const STORAGE_KEY = "pulse-demo-v1";
export const DEMO_EMAIL = "demo@pulse.dev";
export const DEMO_PASSWORD = "pulse-demo-2026";
/** While an outage is simulated, the demo checks every few seconds instead of every minute. */
export const FAST_INTERVAL = 3;
const MAX_MONITORS = 25;

interface DemoUser {
  id: number;
  email: string;
  password: string;
  created_at: string;
}

interface DemoMonitor {
  id: number;
  owner_id: number;
  position: number;
  name: string;
  url: string;
  method: "GET" | "HEAD";
  interval_seconds: number;
  timeout_seconds: number;
  expected_status: number;
  failure_threshold: number;
  recovery_threshold: number;
  status_page_id: number | null;
  is_active: boolean;
  created_at: string;
  base_latency: number;
  outage_rate: number;
  /** Procedural history stops here: a paused monitor has no checks after its pause. */
  paused_at?: string | null;
}

interface DemoPage extends Omit<StatusPage, "monitor_ids"> {
  owner_id: number;
}

interface DemoChannel extends Channel {
  owner_id: number;
}

interface Persisted {
  version: 1;
  users: DemoUser[];
  monitors: DemoMonitor[];
  pages: DemoPage[];
  channels: DemoChannel[];
  nextId: number;
}

interface Runtime {
  status: MonitorStatus;
  failures: number;
  successes: number;
  failingSince: number | null;
  next: number;
  lastCheckedAt: number | null;
  lastLatency: number | null;
  /** Simulated outage: checks fail until it is switched off. */
  forced: boolean;
  fast: boolean;
}

// --- seed ------------------------------------------------------------------------------------

function seed(now: number): Persisted {
  const iso = (t: number) => new Date(t).toISOString();
  const monitor = (
    id: number,
    name: string,
    url: string,
    interval: number,
    base: number,
    rate: number,
    extra: Partial<DemoMonitor> = {},
  ): DemoMonitor => ({
    id,
    owner_id: 1,
    position: id,
    name,
    url,
    method: "GET",
    interval_seconds: interval,
    timeout_seconds: 10,
    expected_status: 200,
    failure_threshold: 3,
    recovery_threshold: 2,
    status_page_id: 1,
    is_active: true,
    created_at: iso(now - 120 * DAY),
    base_latency: base,
    outage_rate: rate,
    ...extra,
  });
  return {
    version: 1,
    users: [{ id: 1, email: DEMO_EMAIL, password: DEMO_PASSWORD, created_at: iso(now - 120 * DAY) }],
    pages: [{ id: 1, owner_id: 1, slug: "acme", title: "Acme", description: "Live status of Acme's API, apps and edge network." }],
    monitors: [
      monitor(1, "API", "https://api.acme.dev/health", 30, 118, 0.02),
      monitor(2, "Website", "https://acme.dev/", 60, 64, 0.008),
      monitor(3, "Dashboard", "https://app.acme.dev/", 60, 142, 0.02),
      monitor(4, "Edge · Frankfurt", "https://fra1.edge.acme.dev/ping", 30, 22, 0.012),
      monitor(5, "Edge · Washington", "https://iad1.edge.acme.dev/ping", 30, 31, 0.012),
      monitor(6, "Payments webhook", "https://api.acme.dev/webhooks/payments", 60, 212, 0.035),
      monitor(7, "Search", "https://search.acme.dev/healthz", 60, 268, 0.028),
      // Added recently, so its oldest bars are empty: no data is not the same as 100%.
      monitor(8, "Docs", "https://docs.acme.dev/", 300, 88, 0.01, { created_at: iso(now - 41 * DAY) }),
      monitor(9, "Staging API", "https://staging.acme.dev/health", 120, 160, 0.05, {
        status_page_id: null,
        is_active: false,
        paused_at: iso(now - 3 * DAY - 5 * HOUR),
      }),
    ],
    channels: [
      {
        id: 1,
        owner_id: 1,
        kind: "webhook",
        name: "Ops webhook",
        target: "https://hooks.acme.dev/pulse",
        is_active: true,
        created_at: iso(now - 30 * DAY),
      },
    ],
    nextId: 100,
  };
}

// --- helpers ---------------------------------------------------------------------------------

const fail = (status: number, detail: string, code?: string): never => {
  throw new ApiError(status, code ? { code, detail } : { detail });
};
const notFound = (what: string) => fail(404, `${what} not found.`, "not_found");
const invalid = (field: string, msg: string): never => {
  throw new ApiError(422, { detail: [{ loc: field === "_" ? ["body"] : ["body", field], msg, type: "value_error" }] });
};

const truncate = (t: number, step: number) => Math.floor(t / step) * step;
const iso = (t: number) => new Date(t).toISOString();

function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h === "::1" ||
    /^(127|10|0)\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
}

function fromChecks(checks: Check[]): Sample {
  const latencies = checks.filter((c) => c.ok && c.latency_ms != null).map((c) => c.latency_ms as number);
  const failures = checks.filter((c) => !c.ok).length;
  if (latencies.length === 0) return { checks: checks.length, failures, avg: null, p50: null, p95: null };
  return {
    checks: checks.length,
    failures,
    avg: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
  };
}

const round = (v: number | null) => (v == null ? null : Math.round(v));
const pct = (s: Sample) => (s.checks ? Math.round(((s.checks - s.failures) * 100 * 1000) / s.checks) / 1000 : null);

// --- engine ----------------------------------------------------------------------------------

type Listener = (event: LiveEvent) => void;

class Engine {
  private state: Persisted;
  private readonly boot = Date.now();
  private runtime = new Map<number, Runtime>();
  private live = new Map<number, Check[]>();
  private liveIncidents: Outage[] = [];
  private listeners = new Map<number, Set<Listener>>();
  private procedural = new Map<number, Outage[]>();
  private memo = new Map<string, Sample>();
  private nextIncidentId = 900_000;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.state = this.load();
    for (const m of this.state.monitors) this.initRuntime(m, false);
  }

  // persistence ------------------------------------------------------------------------------

  private load(): Persisted {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Persisted;
        if (parsed.version === 1) return parsed;
      }
    } catch {
      /* private mode or corrupt state: start over */
    }
    return seed(this.boot);
  }

  private save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      /* ignore */
    }
  }

  reset() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  // simulated worker ---------------------------------------------------------------------------

  private initRuntime(m: DemoMonitor, fresh: boolean) {
    const intervalMs = m.interval_seconds * SECOND;
    const lastGrid = truncate(this.boot, intervalMs);
    this.runtime.set(m.id, {
      status: !m.is_active ? "paused" : fresh ? "pending" : "up",
      failures: 0,
      successes: 0,
      failingSince: null,
      // Stagger the first live checks over the first few seconds so the dashboard wakes up.
      next: fresh ? Date.now() + 400 : this.boot + 1500 + noise(m.id, 1) * Math.min(intervalMs, 12_000),
      lastCheckedAt: fresh || !m.is_active ? null : lastGrid,
      lastLatency: fresh || !m.is_active ? null : checkLatency(this.spec(m), lastGrid),
      forced: false,
      fast: false,
    });
  }

  private ensureRunning() {
    if (this.timer || typeof window === "undefined") return;
    this.timer = setInterval(() => this.tick(Date.now()), 500);
    // A scripted outage on the payments webhook shortly after load, so a visitor who just
    // watches sees an incident open after three failed checks and resolve after two good ones.
    setTimeout(() => {
      const payments = this.state.monitors.find((m) => m.id === 6 && m.is_active);
      const rt = payments && this.runtime.get(6);
      if (!rt || rt.forced || rt.status === "down") return;
      this.setOutage(6, true);
      setTimeout(() => this.setOutage(6, false), 16_000);
    }, 25_000);
  }

  setOutage(monitorId: number, on: boolean) {
    const rt = this.runtime.get(monitorId);
    if (!rt) return;
    rt.forced = on;
    if (on) {
      rt.fast = true;
      rt.next = Math.min(rt.next, Date.now() + 300);
    }
  }

  isSimulating(monitorId: number) {
    return this.runtime.get(monitorId)?.forced ?? false;
  }

  private tick(now: number) {
    for (const m of this.state.monitors) {
      const rt = this.runtime.get(m.id);
      if (!m.is_active || !rt || now < rt.next) continue;
      rt.next = now + (rt.fast ? FAST_INTERVAL : m.interval_seconds) * SECOND;
      this.check(m, rt, now);
    }
  }

  private check(m: DemoMonitor, rt: Runtime, now: number) {
    const spec = this.spec(m);
    const failed = rt.forced || noise(m.id + 77, Math.floor(now / SECOND)) < 0.002;
    const timeout = failed && noise(m.id, Math.floor(now / 7000)) < 0.35;
    const latency = failed ? (timeout ? null : Math.round(spec.baseLatency * 0.6)) : checkLatency(spec, now);
    const list = this.live.get(m.id) ?? [];
    const check: Check = {
      id: Math.floor(now / SECOND),
      checked_at: iso(now),
      ok: !failed,
      status_code: failed ? (timeout ? null : 503) : m.expected_status,
      latency_ms: latency,
      error: failed ? (timeout ? `Timed out after ${m.timeout_seconds}s` : `Expected HTTP ${m.expected_status}, got 503`) : null,
    };
    if (list.at(-1)?.id === check.id) check.id += 1;
    list.push(check);
    if (list.length > 3000) list.splice(0, list.length - 3000);
    this.live.set(m.id, list);

    const [next, action] = step(rt, check.ok, m);
    Object.assign(rt, { status: next.status, failures: next.failures, successes: next.successes });
    rt.lastCheckedAt = now;
    rt.lastLatency = check.latency_ms;
    if (check.ok) rt.failingSince = null;
    else rt.failingSince ??= now;

    this.emit(m.owner_id, { event: "check", data: { monitor_id: m.id, status: rt.status, check } });
    if (action === "open") {
      const incident: Outage = { id: this.nextIncidentId++, monitorId: m.id, start: rt.failingSince ?? now, end: null, cause: check.error ?? "Check failed" };
      this.liveIncidents.push(incident);
      this.emit(m.owner_id, { event: "incident.opened", data: this.incidentEvent(m, incident) });
    } else if (action === "resolve") {
      const incident = this.liveIncidents.find((i) => i.monitorId === m.id && i.end == null);
      if (incident) {
        incident.end = now;
        this.emit(m.owner_id, { event: "incident.resolved", data: this.incidentEvent(m, incident) });
      }
    }
    if (!rt.forced && rt.fast && rt.status !== "down" && rt.successes >= m.recovery_threshold) rt.fast = false;
  }

  private incidentEvent(m: DemoMonitor, i: Outage) {
    return { id: i.id, monitor_id: m.id, monitor_name: m.name, started_at: iso(i.start), resolved_at: i.end == null ? null : iso(i.end), cause: i.cause };
  }

  private emit(userId: number, event: LiveEvent) {
    for (const listener of this.listeners.get(userId) ?? []) listener(event);
  }

  subscribe(token: string | undefined, listener: Listener): () => void {
    const user = this.userFromToken(token);
    if (!user) return () => {};
    this.ensureRunning();
    const set = this.listeners.get(user.id) ?? new Set();
    set.add(listener);
    this.listeners.set(user.id, set);
    return () => set.delete(listener);
  }

  // history ------------------------------------------------------------------------------------

  private spec(m: DemoMonitor): Spec {
    return { id: m.id, baseLatency: m.base_latency, interval: m.interval_seconds, createdAt: Date.parse(m.created_at), outageRate: m.outage_rate };
  }

  /** Procedural history covers [created_at, page load), cut short by a pause. */
  private historyEnd(m: DemoMonitor): number {
    return Math.min(this.boot, m.paused_at ? Date.parse(m.paused_at) : Infinity);
  }

  private outagesFor(m: DemoMonitor): Outage[] {
    let list = this.procedural.get(m.id);
    if (!list) {
      list = outages(this.spec(m), this.boot - 92 * DAY, this.historyEnd(m));
      this.procedural.set(m.id, list);
    }
    return [...list, ...this.liveIncidents.filter((i) => i.monitorId === m.id)];
  }

  /** Aggregate for [start, end): procedural before page load, simulated checks after. */
  private bucket(m: DemoMonitor, start: number, end: number, now: number): Sample {
    const parts: Sample[] = [];
    const historyEnd = this.historyEnd(m);
    if (start < historyEnd) {
      const procEnd = Math.min(end, historyEnd);
      const key = `${m.id}:${m.interval_seconds}:${start}:${procEnd}`;
      let s = this.memo.get(key);
      if (!s) {
        s = sample(this.spec(m), start, procEnd, this.outagesFor(m).filter((o) => o.start < this.boot), now);
        if (this.memo.size > 50_000) this.memo.clear();
        this.memo.set(key, s);
      }
      parts.push(s);
    }
    if (end > this.boot) {
      const from = Math.max(start, this.boot);
      parts.push(fromChecks((this.live.get(m.id) ?? []).filter((c) => {
        const t = Date.parse(c.checked_at);
        return t >= from && t < end && t <= now;
      })));
    }
    return combine(parts);
  }

  private window(m: DemoMonitor, span: number, now: number): Window {
    const parts: Sample[] = [];
    let t = now - span;
    while (t < now) {
      const end = Math.min(truncate(t, HOUR) + HOUR, now);
      parts.push(this.bucket(m, t, end, now));
      t = end;
    }
    const s = combine(parts);
    return { checks: s.checks, uptime: pct(s), avg_ms: round(s.avg), p95_ms: round(s.p95) };
  }

  private monitorOut(m: DemoMonitor, now = Date.now()): Monitor {
    const rt = this.runtime.get(m.id)!;
    const hour = truncate(now, HOUR);
    const { owner_id: _owner, position: _position, base_latency: _base, outage_rate: _rate, paused_at: _paused, ...config } = m;
    return {
      ...config,
      status: rt.status,
      consecutive_failures: rt.failures,
      consecutive_successes: rt.successes,
      last_checked_at: rt.lastCheckedAt == null ? null : iso(rt.lastCheckedAt),
      last_latency_ms: rt.lastLatency,
      stats: {
        "24h": this.window(m, DAY, now),
        "7d": this.window(m, 7 * DAY, now),
        "30d": this.window(m, 30 * DAY, now),
      },
      sparkline: Array.from({ length: 24 }, (_, i) => {
        const start = hour - (23 - i) * HOUR;
        return round(this.bucket(m, start, start + HOUR, now).avg);
      }),
    };
  }

  private latency(m: DemoMonitor, range: RangeKey, now: number): LatencyPoint[] {
    const [span, stepMs] = { "24h": [DAY, 10 * MINUTE], "7d": [7 * DAY, HOUR], "30d": [30 * DAY, 6 * HOUR] }[range];
    const points: LatencyPoint[] = [];
    for (let t = truncate(now - span, stepMs); t <= truncate(now, stepMs); t += stepMs) {
      const s = this.bucket(m, Math.max(t, now - span), Math.min(t + stepMs, now + 1), now);
      points.push({ t: iso(t), checks: s.checks, failures: s.failures, avg_ms: round(s.avg), p50_ms: round(s.p50), p95_ms: round(s.p95) });
    }
    return points;
  }

  private daily(m: DemoMonitor, days: number, now: number): Day[] {
    const today = truncate(now, DAY);
    const list = this.outagesFor(m);
    return Array.from({ length: days }, (_, i) => {
      const start = today - (days - 1 - i) * DAY;
      const end = start + DAY;
      const s = this.bucket(m, start, Math.min(end, now), now);
      const touching = list.filter((o) => o.start < end && (o.end ?? now) > start);
      return {
        date: iso(start).slice(0, 10),
        checks: s.checks,
        failures: s.failures,
        uptime: pct(s),
        downtime_seconds: Math.round(overlap(start, end, touching, now) / SECOND),
        incidents: touching.length,
      };
    });
  }

  private checks(m: DemoMonitor, limit: number, before: number | null, failedOnly: boolean): Check[] {
    const out: Check[] = [];
    const accept = (c: Check) => (before == null || c.id < before) && (!failedOnly || !c.ok);
    const live = this.live.get(m.id) ?? [];
    for (let i = live.length - 1; i >= 0 && out.length < limit; i--) if (accept(live[i])) out.push(live[i]);
    const intervalMs = m.interval_seconds * SECOND;
    const spec = this.spec(m);
    const list = this.outagesFor(m);
    const stopAt = Math.max(spec.createdAt, this.boot - 14 * DAY);
    for (let t = truncate(this.historyEnd(m) - 1, intervalMs); t >= stopAt && out.length < limit; t -= intervalMs) {
      const down = list.find((o) => o.start <= t && (o.end ?? this.boot) > t);
      const timeout = down?.cause.startsWith("Timed out");
      const c: Check = {
        id: Math.floor(t / SECOND),
        checked_at: iso(t),
        ok: !down,
        status_code: down ? (timeout ? null : Number(down.cause.match(/got (\d+)/)?.[1] ?? 503)) : m.expected_status,
        latency_ms: down ? (timeout ? null : Math.round(spec.baseLatency * 0.6)) : checkLatency(spec, t),
        error: down ? down.cause : null,
      };
      if (accept(c)) out.push(c);
    }
    return out;
  }

  private incidents(user: DemoUser, now: number): Incident[] {
    const mine = this.state.monitors.filter((m) => m.owner_id === user.id);
    return mine
      .flatMap((m) =>
        this.outagesFor(m).map((o) => ({
          id: o.id,
          monitor_id: m.id,
          monitor_name: m.name,
          started_at: iso(o.start),
          resolved_at: o.end == null ? null : iso(o.end),
          cause: o.cause,
          duration_seconds: Math.round(((o.end ?? now) - o.start) / SECOND),
        })),
      )
      .filter((i) => Date.parse(i.started_at) >= now - 90 * DAY)
      .sort((a, b) => b.started_at.localeCompare(a.started_at));
  }

  // auth ---------------------------------------------------------------------------------------

  private userFromToken(token: string | undefined): DemoUser | undefined {
    const match = token?.match(/^demo-(access|refresh)\.(\d+)$/);
    return match ? this.state.users.find((u) => u.id === Number(match[2])) : undefined;
  }

  private authed(headers: Record<string, string>): DemoUser {
    const token = headers.Authorization?.replace(/^Bearer /, "");
    const user = token?.startsWith("demo-access.") ? this.userFromToken(token) : undefined;
    return user ?? fail(401, token ? "Token is invalid or expired." : "Authentication credentials were not provided.", "not_authenticated");
  }

  private tokens(user: DemoUser) {
    return { access: `demo-access.${user.id}`, refresh: `demo-refresh.${user.id}`, token_type: "bearer" };
  }

  // validation -------------------------------------------------------------------------------

  private validateMonitor(body: Record<string, unknown>, current?: DemoMonitor): Partial<DemoMonitor> {
    const out: Partial<DemoMonitor> = {};
    const has = (k: string) => body[k] !== undefined;
    const intIn = (k: keyof DemoMonitor, min: number, max: number) => {
      if (!has(k)) return;
      const v = Number(body[k]);
      if (!Number.isInteger(v)) invalid(k, "Input should be a valid integer");
      if (v < min) invalid(k, `Input should be greater than or equal to ${min}`);
      if (v > max) invalid(k, `Input should be less than or equal to ${max}`);
      (out as Record<string, unknown>)[k] = v;
    };
    if (has("name")) {
      const name = String(body.name).trim();
      if (!name) invalid("name", "String should have at least 1 character");
      out.name = name.slice(0, 100);
    } else if (!current) invalid("name", "Field required");
    if (has("url")) {
      let url: URL;
      try {
        url = new URL(String(body.url));
      } catch {
        return invalid("url", "Input should be a valid URL, relative URL without a base");
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") invalid("url", "URL scheme should be 'http' or 'https'");
      if (isPrivateHost(url.hostname)) fail(422, `${url.hostname} resolves to a non-public address`, "blocked_target");
      out.url = url.toString();
    } else if (!current) invalid("url", "Field required");
    if (has("method")) {
      if (body.method !== "GET" && body.method !== "HEAD") invalid("method", "Input should be 'GET' or 'HEAD'");
      out.method = body.method as "GET" | "HEAD";
    }
    intIn("interval_seconds", 30, 3600);
    intIn("timeout_seconds", 1, 30);
    intIn("expected_status", 100, 599);
    intIn("failure_threshold", 1, 10);
    intIn("recovery_threshold", 1, 10);
    const interval = out.interval_seconds ?? current?.interval_seconds ?? 60;
    const timeout = out.timeout_seconds ?? current?.timeout_seconds ?? 10;
    if (timeout >= interval) {
      if (current) fail(422, "timeout_seconds must be lower than interval_seconds", "invalid");
      invalid("_", "Value error, timeout_seconds must be lower than interval_seconds");
    }
    if (has("status_page_id")) out.status_page_id = body.status_page_id == null ? null : Number(body.status_page_id);
    return out;
  }

  // router -------------------------------------------------------------------------------------

  handle(method: string, rawUrl: string, body: unknown, headers: Record<string, string>): { status: number; data: unknown } {
    this.ensureRunning();
    const url = new URL(rawUrl, "http://demo");
    const path = url.pathname.replace(/\/$/, "");
    const q = url.searchParams;
    const input = (body ?? {}) as Record<string, unknown>;
    const now = Date.now();
    const route = `${method} ${path}`;
    let m: RegExpMatchArray | null;

    // auth
    if (route === "POST /api/auth/login") {
      const email = String(input.email ?? "").toLowerCase();
      const user = this.state.users.find((u) => u.email === email && u.password === input.password);
      return { status: 200, data: user ? this.tokens(user) : fail(401, "Email or password is incorrect.", "not_authenticated") };
    }
    if (route === "POST /api/auth/register") {
      const email = String(input.email ?? "").toLowerCase().trim();
      const password = String(input.password ?? "");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) invalid("email", "value is not a valid email address");
      if (password.length < 8) invalid("password", "String should have at least 8 characters");
      if (this.state.users.some((u) => u.email === email)) fail(409, "An account with this email already exists.", "email_taken");
      const user = { id: this.state.nextId++, email, password, created_at: iso(now) };
      this.state.users.push(user);
      this.save();
      return { status: 201, data: this.tokens(user) };
    }
    if (route === "POST /api/auth/refresh") {
      const token = String(input.refresh ?? "");
      const user = token.startsWith("demo-refresh.") ? this.userFromToken(token) : undefined;
      return { status: 200, data: user ? { access: `demo-access.${user.id}` } : fail(401, "Refresh token is invalid or expired.", "not_authenticated") };
    }

    // public status page
    if (method === "GET" && (m = path.match(/^\/api\/status\/([\w-]+)$/))) {
      const page = this.state.pages.find((p) => p.slug === m![1]) ?? notFound("Status page");
      return { status: 200, data: this.publicStatus(page, now) };
    }

    const user = this.authed(headers);
    const owned = (id: string | number) =>
      this.state.monitors.find((x) => x.id === Number(id) && x.owner_id === user.id) ?? notFound("Monitor");
    const mine = () => this.state.monitors.filter((x) => x.owner_id === user.id).sort((a, b) => a.position - b.position || a.id - b.id);

    if (route === "GET /api/auth/me") return { status: 200, data: { id: user.id, email: user.email, created_at: user.created_at } };

    if (route === "GET /api/monitors") return { status: 200, data: mine().map((x) => this.monitorOut(x, now)) };
    if (route === "POST /api/monitors") {
      const count = mine().length;
      if (count >= MAX_MONITORS) fail(409, `You can have at most ${MAX_MONITORS} monitors.`, "monitor_limit");
      const fields = this.validateMonitor(input);
      if (fields.status_page_id != null && !this.state.pages.some((p) => p.id === fields.status_page_id && p.owner_id === user.id)) {
        notFound("Status page");
      }
      const monitor: DemoMonitor = {
        id: this.state.nextId++,
        owner_id: user.id,
        position: count + 100,
        method: "GET",
        interval_seconds: 60,
        timeout_seconds: 10,
        expected_status: 200,
        failure_threshold: 3,
        recovery_threshold: 2,
        status_page_id: null,
        is_active: true,
        created_at: iso(now),
        base_latency: 60 + Math.round(noise(now % 1000, 3) * 240),
        outage_rate: 0.01,
        ...(fields as Pick<DemoMonitor, "name" | "url">),
      };
      this.state.monitors.push(monitor);
      this.initRuntime(monitor, true);
      this.save();
      return { status: 201, data: this.monitorOut(monitor, now) };
    }
    if ((m = path.match(/^\/api\/monitors\/(\d+)(?:\/([\w-]+))?$/))) {
      const monitor = owned(m[1]);
      const rt = this.runtime.get(monitor.id)!;
      const sub = m[2];
      if (!sub && method === "GET") return { status: 200, data: this.monitorOut(monitor, now) };
      if (!sub && method === "PATCH") {
        const fields = this.validateMonitor(input, monitor);
        Object.assign(monitor, fields);
        if (fields.interval_seconds) rt.next = Math.min(rt.next, now + fields.interval_seconds * SECOND);
        this.memo.clear();
        this.save();
        return { status: 200, data: this.monitorOut(monitor, now) };
      }
      if (!sub && method === "DELETE") {
        this.state.monitors = this.state.monitors.filter((x) => x.id !== monitor.id);
        this.runtime.delete(monitor.id);
        this.live.delete(monitor.id);
        this.liveIncidents = this.liveIncidents.filter((i) => i.monitorId !== monitor.id);
        this.save();
        return { status: 204, data: null };
      }
      if (sub === "pause" && method === "POST") {
        for (const i of this.liveIncidents) if (i.monitorId === monitor.id && i.end == null) i.end = now;
        monitor.is_active = false;
        monitor.paused_at ??= iso(now);
        Object.assign(rt, { status: "paused", failures: 0, successes: 0, failingSince: null, forced: false, fast: false });
        this.save();
        return { status: 200, data: this.monitorOut(monitor, now) };
      }
      if (sub === "resume" && method === "POST") {
        if (!monitor.is_active) {
          monitor.is_active = true;
          Object.assign(rt, { status: "pending", next: now + 300 });
          this.save();
        }
        return { status: 200, data: this.monitorOut(monitor, now) };
      }
      if (sub === "latency" && method === "GET") {
        const range = (q.get("range") ?? "24h") as RangeKey;
        if (!["24h", "7d", "30d"].includes(range)) invalid("range", "Input should be '24h', '7d' or '30d'");
        return { status: 200, data: this.latency(monitor, range, now) };
      }
      if (sub === "uptime" && method === "GET") {
        const days = Number(q.get("days") ?? 90);
        if (!(days >= 1 && days <= 90)) invalid("days", "Input should be less than or equal to 90");
        return { status: 200, data: this.daily(monitor, days, now) };
      }
      if (sub === "checks" && method === "GET") {
        const before = q.get("before");
        return {
          status: 200,
          data: this.checks(monitor, Math.min(Number(q.get("limit") ?? 50), 200), before ? Number(before) : null, q.get("failed") === "true"),
        };
      }
    }

    if (route === "GET /api/incidents") {
      const state = q.get("state") ?? "all";
      const monitorId = q.get("monitor");
      let list = this.incidents(user, now);
      if (state === "open") list = list.filter((i) => i.resolved_at == null);
      if (state === "resolved") list = list.filter((i) => i.resolved_at != null);
      if (monitorId) list = list.filter((i) => i.monitor_id === Number(monitorId));
      return { status: 200, data: list.slice(0, Number(q.get("limit") ?? 50)) };
    }

    if (route === "GET /api/status-pages") {
      return { status: 200, data: this.state.pages.filter((p) => p.owner_id === user.id).map((p) => this.pageOut(p)) };
    }
    if (route === "POST /api/status-pages") {
      const slug = String(input.slug ?? "");
      if (!/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/.test(slug)) invalid("slug", "String should match pattern '^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$'");
      const title = String(input.title ?? "").trim();
      if (!title) invalid("title", "String should have at least 1 character");
      if (this.state.pages.some((p) => p.slug === slug)) fail(409, `/status/${slug} is already taken.`, "slug_taken");
      const page: DemoPage = { id: this.state.nextId++, owner_id: user.id, slug, title, description: String(input.description ?? "") };
      this.state.pages.push(page);
      this.save();
      return { status: 201, data: this.pageOut(page) };
    }

    if (route === "GET /api/channels") {
      return { status: 200, data: this.state.channels.filter((c) => c.owner_id === user.id).map(({ owner_id: _o, secret: _s, ...c }) => c) };
    }
    if (route === "POST /api/channels") {
      const kind = input.kind;
      const target = String(input.target ?? "").trim();
      const name = String(input.name ?? "").trim();
      if (kind !== "webhook" && kind !== "telegram") invalid("kind", "Input should be 'telegram' or 'webhook'");
      if (!name) invalid("name", "String should have at least 1 character");
      if (kind === "webhook") {
        let url: URL;
        try {
          url = new URL(target);
        } catch {
          return invalid("_", "Value error, Input should be a valid URL");
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") invalid("_", "Value error, URL scheme should be 'http' or 'https'");
        if (isPrivateHost(url.hostname)) fail(422, `${url.hostname} resolves to a non-public address`, "blocked_target");
      } else if (!/^-?\d+$/.test(target) && !target.startsWith("@")) {
        invalid("_", "Value error, Telegram target must be a numeric chat id or @channel");
      }
      const secret =
        kind === "webhook" ? Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("") : null;
      const channel: DemoChannel = { id: this.state.nextId++, owner_id: user.id, kind: kind as Channel["kind"], name, target, is_active: true, created_at: iso(now) };
      this.state.channels.push(channel);
      this.save();
      const { owner_id: _o, ...out } = channel;
      return { status: 201, data: { ...out, secret } };
    }
    if ((m = path.match(/^\/api\/channels\/(\d+)(\/test)?$/))) {
      const channel = this.state.channels.find((c) => c.id === Number(m![1]) && c.owner_id === user.id) ?? notFound("Channel");
      if (method === "DELETE" && !m[2]) {
        this.state.channels = this.state.channels.filter((c) => c !== channel);
        this.save();
        return { status: 204, data: null };
      }
      if (method === "POST" && m[2]) {
        return { status: 200, data: { ok: true, detail: "Delivered (simulated: the demo has no server to send from)." } };
      }
    }

    return fail(404, "Not Found");
  }

  private pageOut(p: DemoPage): StatusPage {
    const { owner_id: _o, ...page } = p;
    return { ...page, monitor_ids: this.state.monitors.filter((m) => m.status_page_id === p.id).map((m) => m.id) };
  }

  private publicStatus(page: DemoPage, now: number): PublicStatus {
    const monitors = this.state.monitors.filter((m) => m.status_page_id === page.id).sort((a, b) => a.position - b.position || a.id - b.id);
    const statuses = monitors.map((m) => this.runtime.get(m.id)!.status);
    const judged = statuses.filter((s) => s === "up" || s === "down");
    const down = judged.filter((s) => s === "down").length;
    const status: Overall = judged.length === 0 ? "unknown" : down === 0 ? "operational" : down === judged.length ? "major_outage" : "partial_outage";
    return {
      slug: page.slug,
      title: page.title,
      description: page.description,
      status,
      updated_at: iso(now),
      monitors: monitors.map((m) => {
        const days = this.daily(m, 90, now);
        const checks = days.reduce((a, d) => a + d.checks, 0);
        const failures = days.reduce((a, d) => a + d.failures, 0);
        return {
          id: m.id,
          name: m.name,
          status: this.runtime.get(m.id)!.status,
          uptime_90d: checks ? Math.round(((checks - failures) * 100 * 1000) / checks) / 1000 : null,
          days,
        };
      }),
      incidents: monitors
        .flatMap((m) => this.outagesFor(m).map((o) => ({ o, name: m.name })))
        .filter(({ o }) => o.end == null || o.start >= now - 14 * DAY)
        .sort((a, b) => b.o.start - a.o.start)
        .slice(0, 50)
        .map(({ o, name }) => ({
          id: o.id,
          monitor_name: name,
          started_at: iso(o.start),
          resolved_at: o.end == null ? null : iso(o.end),
          duration_seconds: Math.round(((o.end ?? now) - o.start) / SECOND),
        })),
    };
  }
}

let engine: Engine | null = null;
export const demo = () => (engine ??= new Engine());

/** Same shape as fetch() + JSON: resolves with { status, data } or rejects with ApiError. */
export async function demoFetch(method: string, url: string, body: unknown, headers: Record<string, string>) {
  // A little latency, so loading states are real and nothing renders in an impossible zero time.
  await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 90));
  return demo().handle(method, url, body === undefined ? undefined : JSON.parse(JSON.stringify(body)), headers);
}
