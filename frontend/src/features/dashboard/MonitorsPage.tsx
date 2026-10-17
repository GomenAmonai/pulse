import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { Link } from "react-router";

import { Sparkline } from "../../components/Sparkline";
import { Button, Card, Skeleton, StatusDot } from "../../components/ui";
import { api } from "../../lib/api";
import { ago, host, ms, pct } from "../../lib/format";
import type { Monitor } from "../../lib/types";
import { useLive } from "./live";
import { MonitorForm } from "./MonitorForm";
import { useNow } from "./useNow";

export function MonitorsPage() {
  const [creating, setCreating] = useState(false);
  const monitors = useQuery({ queryKey: ["monitors"], queryFn: api.monitors, refetchInterval: 60_000 });
  const list = monitors.data ?? [];
  const counts = {
    up: list.filter((m) => m.status === "up").length,
    down: list.filter((m) => m.status === "down").length,
    paused: list.filter((m) => m.status === "paused").length,
  };
  const active = list.filter((m) => m.stats["24h"].checks > 0);
  const checks = active.reduce((a, m) => a + m.stats["24h"].checks, 0);
  const uptime = checks ? active.reduce((a, m) => a + (m.stats["24h"].uptime ?? 0) * m.stats["24h"].checks, 0) / checks : null;

  return (
    <>
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold title">Monitors</h1>
          <p className="mt-1 text-sm text-muted">HTTP checks, response times and uptime over the last 24 hours.</p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Plus className="size-4" /> New monitor
        </Button>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Up" value={counts.up} tone="text-up" loading={monitors.isPending} />
        <Stat label="Down" value={counts.down} tone={counts.down ? "text-down" : undefined} loading={monitors.isPending} />
        <Stat label="Paused" value={counts.paused} loading={monitors.isPending} />
        <Stat label="Uptime · 24h" value={pct(uptime)} loading={monitors.isPending} />
      </div>

      <Card className="overflow-hidden">
        <div className="hidden grid-cols-[minmax(0,1fr)_140px_90px_90px_100px] gap-4 border-b border-border bg-surface-2 px-5 py-2.5 text-xs font-medium text-muted md:grid">
          <span>Monitor</span>
          <span>Response · 24h</span>
          <span className="text-right">p95</span>
          <span className="text-right">Uptime</span>
          <span className="text-right">Checked</span>
        </div>
        {monitors.isPending ? (
          Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex items-center gap-4 border-b border-border px-5 py-4 last:border-0">
              <Skeleton className="size-2 rounded-full" />
              <Skeleton className="h-4 w-48" />
            </div>
          ))
        ) : list.length === 0 ? (
          <div className="px-5 py-16 text-center">
            <p className="font-medium">No monitors yet</p>
            <p className="mt-1 text-sm text-muted">Add a URL and Pulse starts checking it within a second.</p>
            <Button variant="primary" className="mt-5" onClick={() => setCreating(true)}>
              <Plus className="size-4" /> New monitor
            </Button>
          </div>
        ) : (
          <ul>
            <AnimatePresence initial={false}>
              {list.map((m) => (
                <motion.li
                  key={m.id}
                  layout="position"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ type: "spring", bounce: 0, duration: 0.35 }}
                  className="border-b border-border last:border-0"
                >
                  <Row monitor={m} />
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </Card>

      <MonitorForm open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function Stat({ label, value, tone, loading }: { label: string; value: number | string; tone?: string; loading: boolean }) {
  return (
    <Card className="px-4 py-3.5">
      <div className="text-xs text-muted">{label}</div>
      {loading ? <Skeleton className="mt-2 h-6 w-12" /> : <div className={`mono mt-1 text-xl font-medium ${tone ?? ""}`}>{value}</div>}
    </Card>
  );
}

function Row({ monitor: m }: { monitor: Monitor }) {
  const { beats } = useLive();
  const now = useNow();
  const day = m.stats["24h"];
  return (
    <Link
      to={`/dashboard/monitors/${m.id}`}
      className="hoverable grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-5 py-3.5 transition-colors md:grid-cols-[minmax(0,1fr)_140px_90px_90px_100px]"
    >
      <span className="flex min-w-0 items-center gap-3">
        <StatusDot status={m.status} beatKey={beats[m.id]} />
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{m.name}</span>
          <span className="mono block truncate text-xs text-muted">{host(m.url)}</span>
        </span>
      </span>
      <span className="hidden md:block">
        <Sparkline values={m.sparkline} tone={m.status === "down" ? "var(--down)" : "var(--chart)"} />
      </span>
      <span className="mono hidden text-right text-sm md:block">{ms(day.p95_ms)}</span>
      <span className={`mono text-right text-sm ${day.uptime != null && day.uptime < 99 ? "text-down" : ""}`}>{pct(day.uptime)}</span>
      <span className="mono hidden text-right text-xs text-muted md:block">{m.is_active ? ago(m.last_checked_at, now) : "paused"}</span>
    </Link>
  );
}
