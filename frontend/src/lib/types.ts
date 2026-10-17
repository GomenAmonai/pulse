// Mirrors app/schemas.py on the backend.

export type MonitorStatus = "pending" | "up" | "down" | "paused";
export type RangeKey = "24h" | "7d" | "30d";

export interface Tokens {
  access: string;
  refresh: string;
}

export interface User {
  id: number;
  email: string;
  created_at: string;
}

export interface Window {
  checks: number;
  uptime: number | null;
  avg_ms: number | null;
  p95_ms: number | null;
}

export interface Monitor {
  id: number;
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
  status: MonitorStatus;
  consecutive_failures: number;
  consecutive_successes: number;
  last_checked_at: string | null;
  last_latency_ms: number | null;
  created_at: string;
  stats: Record<RangeKey, Window>;
  sparkline: (number | null)[];
}

export type MonitorInput = Pick<
  Monitor,
  | "name"
  | "url"
  | "method"
  | "interval_seconds"
  | "timeout_seconds"
  | "expected_status"
  | "failure_threshold"
  | "recovery_threshold"
  | "status_page_id"
>;

export interface LatencyPoint {
  t: string;
  checks: number;
  failures: number;
  avg_ms: number | null;
  p50_ms: number | null;
  p95_ms: number | null;
}

export interface Day {
  date: string;
  checks: number;
  failures: number;
  uptime: number | null;
  downtime_seconds: number;
  incidents: number;
}

export interface Check {
  id: number;
  checked_at: string;
  ok: boolean;
  status_code: number | null;
  latency_ms: number | null;
  error: string | null;
}

export interface Incident {
  id: number;
  monitor_id: number;
  monitor_name: string;
  started_at: string;
  resolved_at: string | null;
  cause: string;
  duration_seconds: number;
}

export interface StatusPage {
  id: number;
  slug: string;
  title: string;
  description: string;
  monitor_ids: number[];
}

export type Overall = "operational" | "degraded" | "partial_outage" | "major_outage" | "unknown";

export interface PublicStatus {
  slug: string;
  title: string;
  description: string;
  status: Overall;
  updated_at: string;
  monitors: { id: number; name: string; status: MonitorStatus; uptime_90d: number | null; days: Day[] }[];
  incidents: { id: number; monitor_name: string; started_at: string; resolved_at: string | null; duration_seconds: number }[];
}

export type ChannelKind = "webhook" | "telegram";

export interface Channel {
  id: number;
  kind: ChannelKind;
  name: string;
  target: string;
  is_active: boolean;
  created_at: string;
  secret?: string | null;
}

/** Server-sent events from /api/stream. */
export type LiveEvent =
  | {
      event: "check";
      data: {
        monitor_id: number;
        status: MonitorStatus;
        check: { ok: boolean; checked_at: string; status_code: number | null; latency_ms: number | null; error: string | null };
      };
    }
  | {
      event: "incident.opened" | "incident.resolved";
      data: { id: number; monitor_id: number; monitor_name: string; started_at: string; resolved_at: string | null; cause: string };
    };
