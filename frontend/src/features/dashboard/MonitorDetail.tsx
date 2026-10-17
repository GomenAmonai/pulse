import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, FlaskConical, Pause, Pencil, Play, Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";

import { LatencyChart } from "../../components/LatencyChart";
import { useToast } from "../../components/Toast";
import { Button, Card, Skeleton, StatusBadge, StatusDot } from "../../components/ui";
import { UptimeBars } from "../../components/UptimeBars";
import { demo, FAST_INTERVAL } from "../../demo/engine";
import { api, DEMO } from "../../lib/api";
import { ago, dateTime, duration, ms, pct, time } from "../../lib/format";
import type { Monitor, RangeKey } from "../../lib/types";
import { useLive } from "./live";
import { MonitorForm } from "./MonitorForm";
import { useNow } from "./useNow";

export function MonitorDetail() {
  const id = Number(useParams().id);
  const monitor = useQuery({ queryKey: ["monitor", id], queryFn: () => api.monitor(id), refetchInterval: 60_000 });

  if (monitor.isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-24" />
        <Skeleton className="h-72" />
      </div>
    );
  }
  if (monitor.isError) {
    return (
      <div className="py-24 text-center">
        <h1 className="text-xl font-semibold">Monitor not found</h1>
        <Link to="/dashboard" className="mt-4 inline-block text-sm underline underline-offset-4">
          Back to monitors
        </Link>
      </div>
    );
  }
  return <Detail monitor={monitor.data} />;
}

function Detail({ monitor: m }: { monitor: Monitor }) {
  const [range, setRange] = useState<RangeKey>("24h");
  const [editing, setEditing] = useState(false);
  const { beats } = useLive();

  return (
    <>
      <Link to="/dashboard" className="mb-5 inline-flex items-center gap-1.5 text-sm text-muted hover:text-text">
        <ArrowLeft className="size-4" /> Monitors
      </Link>

      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <StatusDot status={m.status} beatKey={beats[m.id]} size={10} />
            <h1 className="truncate text-2xl font-semibold title">{m.name}</h1>
            <StatusBadge status={m.status} />
          </div>
          <p className="mono mt-2 truncate text-sm text-muted">
            <span className="text-subtle">{m.method}</span> {m.url}
          </p>
          <p className="mt-1 text-[13px] text-subtle">
            Every {m.interval_seconds}s · timeout {m.timeout_seconds}s · expects {m.expected_status} · opens after {m.failure_threshold} failures, closes
            after {m.recovery_threshold} successes
          </p>
        </div>
        <Actions monitor={m} onEdit={() => setEditing(true)} />
      </div>

      <FlapMeter monitor={m} />

      <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Kpi label="Uptime · 24h" value={pct(m.stats["24h"].uptime)} sub={`${m.stats["24h"].checks.toLocaleString("en")} checks`} />
        <Kpi label="Uptime · 7d" value={pct(m.stats["7d"].uptime)} sub={`${m.stats["7d"].checks.toLocaleString("en")} checks`} />
        <Kpi label="Uptime · 30d" value={pct(m.stats["30d"].uptime)} sub={`${m.stats["30d"].checks.toLocaleString("en")} checks`} />
        <Kpi label="p95 · 24h" value={ms(m.stats["24h"].p95_ms)} sub={`p95 · 7d ${ms(m.stats["7d"].p95_ms)}`} />
        <Kpi label="Last response" value={ms(m.last_latency_ms)} sub={<LastChecked at={m.last_checked_at} paused={!m.is_active} />} />
      </div>

      <Card className="mt-6 p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium">Response time</h2>
            <div className="mt-1 flex items-center gap-4 text-xs text-muted">
              <span className="flex items-center gap-1.5">
                <span className="h-0.5 w-3 rounded bg-text" /> average
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-0 w-3 border-t border-dashed border-subtle" /> p95
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-[3px] rounded-sm bg-down" /> failed checks
              </span>
            </div>
          </div>
          <Segmented value={range} onChange={setRange} options={["24h", "7d", "30d"]} />
        </div>
        <Latency id={m.id} range={range} />
      </Card>

      <Card className="mt-6 p-5">
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-sm font-medium">Uptime</h2>
          <span className="text-xs text-muted">Last 90 days, UTC</span>
        </div>
        <Bars id={m.id} />
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-[3fr_2fr]">
        <RecentChecks id={m.id} />
        <MonitorIncidents id={m.id} />
      </div>

      <MonitorForm open={editing} onClose={() => setEditing(false)} monitor={m} />
    </>
  );
}

function LastChecked({ at, paused }: { at: string | null; paused: boolean }) {
  const now = useNow();
  return <>{paused ? "paused" : ago(at, now)}</>;
}

function Kpi({ label, value, sub }: { label: string; value: string; sub: React.ReactNode }) {
  return (
    <Card className="px-4 py-3.5">
      <div className="text-xs text-muted">{label}</div>
      <div className="mono mt-1 text-xl font-medium">{value}</div>
      <div className="mono mt-0.5 truncate text-xs text-subtle">{sub}</div>
    </Card>
  );
}

/**
 * Flap protection made visible: how many consecutive failures (or successes) the current
 * streak has, against the threshold that opens (or resolves) an incident.
 */
function FlapMeter({ monitor: m }: { monitor: Monitor }) {
  const opening = m.status !== "down" && m.consecutive_failures > 0;
  const closing = m.status === "down";
  const show = m.is_active && (opening || closing);
  const total = closing ? m.recovery_threshold : m.failure_threshold;
  const filled = closing ? m.consecutive_successes : m.consecutive_failures;
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ type: "spring", bounce: 0, duration: 0.35 }}
          className="overflow-hidden"
        >
          <div className={`mt-5 flex flex-wrap items-center gap-3 rounded-lg px-4 py-3 text-sm ${closing ? "bg-down-soft" : "bg-warn-soft"}`}>
            <div className="flex gap-1">
              {Array.from({ length: total }, (_, i) => (
                <motion.span
                  key={i}
                  className="h-2 w-6 rounded-full"
                  animate={{ backgroundColor: i < filled ? (closing ? "var(--up)" : "var(--down)") : "var(--border-strong)" }}
                  transition={{ duration: 0.2 }}
                />
              ))}
            </div>
            <span>
              {closing ? (
                <>
                  Incident open · <b>{filled}</b> of {total} good checks to resolve it
                </>
              ) : (
                <>
                  <b>{filled}</b> of {total} failed checks in a row · an incident opens at {total}
                </>
              )}
            </span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Actions({ monitor: m, onEdit }: { monitor: Monitor; onEdit: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  // Read from the engine on every render: the scripted outage can start and stop on its own,
  // and every live check re-renders this component anyway.
  const [, rerender] = useState(0);
  const simulating = DEMO && demo().isSimulating(m.id);

  const refresh = (updated: Monitor) => {
    client.setQueryData(["monitor", m.id], updated);
    void client.invalidateQueries({ queryKey: ["monitors"] });
    void client.invalidateQueries({ queryKey: ["incidents"] });
  };
  const toggle = useMutation({
    mutationFn: () => (m.is_active ? api.pause(m.id) : api.resume(m.id)),
    onSuccess: (updated) => {
      refresh(updated);
      toast(updated.is_active ? "Monitoring resumed" : "Monitor paused");
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteMonitor(m.id),
    onSuccess: () => {
      client.removeQueries({ queryKey: ["monitor", m.id] });
      void client.invalidateQueries({ queryKey: ["monitors"] });
      toast(`Deleted ${m.name}`);
      navigate("/dashboard");
    },
  });

  return (
    <div className="flex flex-wrap items-center gap-2">
      {DEMO && m.is_active && (
        <Button
          size="sm"
          variant={simulating ? "danger" : "secondary"}
          title={`Demo only: make this monitor's checks fail. While simulating, checks run every ${FAST_INTERVAL}s.`}
          onClick={() => {
            demo().setOutage(m.id, !simulating);
            rerender((n) => n + 1);
          }}
        >
          <FlaskConical className="size-3.5" />
          {simulating ? "Stop outage" : "Simulate outage"}
        </Button>
      )}
      <Button size="sm" onClick={() => toggle.mutate()} disabled={toggle.isPending}>
        {m.is_active ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
        {m.is_active ? "Pause" : "Resume"}
      </Button>
      <Button size="sm" onClick={onEdit}>
        <Pencil className="size-3.5" /> Edit
      </Button>
      {confirming ? (
        <Button size="sm" variant="danger" onClick={() => remove.mutate()} disabled={remove.isPending} onBlur={() => setConfirming(false)} autoFocus>
          <Trash2 className="size-3.5" /> Delete with history?
        </Button>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setConfirming(true)} aria-label="Delete monitor">
          <Trash2 className="size-3.5" />
        </Button>
      )}
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: T[] }) {
  return (
    <div className="flex rounded-md border border-border p-0.5" role="radiogroup">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={value === option}
          onClick={() => onChange(option)}
          className={`pressable relative h-7 rounded px-3 text-xs font-medium ${value === option ? "text-text" : "text-muted hover:text-text"}`}
        >
          {value === option && (
            <motion.span layoutId={`seg-${options.join()}`} className="absolute inset-0 rounded bg-surface-3" transition={{ type: "spring", bounce: 0, duration: 0.3 }} />
          )}
          <span className="relative">{option}</span>
        </button>
      ))}
    </div>
  );
}

function Latency({ id, range }: { id: number; range: RangeKey }) {
  const query = useQuery({
    queryKey: ["latency", id, range],
    queryFn: () => api.latency(id, range),
    refetchInterval: range === "24h" ? 30_000 : 300_000,
    placeholderData: (previous) => previous,
  });
  if (!query.data) return <Skeleton className="h-[220px]" />;
  return (
    <div className={`transition-opacity duration-200 ${query.isPlaceholderData ? "opacity-50" : ""}`}>
      <LatencyChart points={query.data} />
    </div>
  );
}

function Bars({ id }: { id: number }) {
  const query = useQuery({ queryKey: ["uptime", id], queryFn: () => api.uptime(id), refetchInterval: 120_000 });
  if (!query.data) return <Skeleton className="h-8" />;
  const checks = query.data.reduce((a, d) => a + d.checks, 0);
  const failures = query.data.reduce((a, d) => a + d.failures, 0);
  return (
    <>
      <UptimeBars days={query.data} />
      <div className="mt-2 flex justify-between text-xs text-subtle">
        <span>90 days ago</span>
        <span className="mono">{pct(checks ? ((checks - failures) * 100) / checks : null)} uptime</span>
        <span>Today</span>
      </div>
    </>
  );
}

function RecentChecks({ id }: { id: number }) {
  const [failedOnly, setFailedOnly] = useState(false);
  const query = useQuery({
    queryKey: failedOnly ? ["checks", id, "failed"] : ["checks", id],
    queryFn: () => api.checks(id, { limit: 50, failed: failedOnly }),
  });
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <h2 className="text-sm font-medium">Recent checks</h2>
        <Segmented value={failedOnly ? "Failed" : "All"} onChange={(v) => setFailedOnly(v === "Failed")} options={["All", "Failed"]} />
      </div>
      <div className="max-h-[420px] overflow-y-auto">
        {!query.data ? (
          <div className="space-y-2 p-5">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-5" />
            ))}
          </div>
        ) : query.data.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-muted">{failedOnly ? "No failed checks." : "No checks yet."}</p>
        ) : (
          <table className="w-full table-fixed text-sm">
            <colgroup>
              <col className="w-9" />
              <col className="w-20" />
              <col className="w-12" />
              <col className="w-20" />
              <col />
            </colgroup>
            <tbody>
              <AnimatePresence initial={false}>
                {query.data.map((c) => (
                  <motion.tr
                    key={c.id}
                    initial={{ opacity: 0, backgroundColor: "var(--surface-3)" }}
                    animate={{ opacity: 1, backgroundColor: "rgba(0,0,0,0)" }}
                    transition={{ duration: 0.8 }}
                    className="border-b border-border last:border-0"
                  >
                    <td className="py-2 pr-2 pl-5">
                      <span className={`inline-block size-1.5 rounded-full ${c.ok ? "bg-up" : "bg-down"}`} />
                    </td>
                    <td className="mono py-2 pr-3 text-xs whitespace-nowrap text-muted">{time(c.checked_at)}</td>
                    <td className={`mono py-2 pr-3 text-xs ${c.ok ? "" : "text-down"}`}>{c.status_code ?? "—"}</td>
                    <td className="mono py-2 pr-4 text-right text-xs">{ms(c.latency_ms)}</td>
                    <td className="truncate py-2 pr-5 text-xs text-muted" title={c.error ?? undefined}>
                      {c.error}
                    </td>
                  </motion.tr>
                ))}
              </AnimatePresence>
            </tbody>
          </table>
        )}
      </div>
    </Card>
  );
}

function MonitorIncidents({ id }: { id: number }) {
  const query = useQuery({ queryKey: ["incidents", { monitor: id }], queryFn: () => api.incidents({ monitor: id, limit: 20 }) });
  const now = useNow();
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-border px-5 py-3">
        <h2 className="text-sm font-medium">Incidents</h2>
      </div>
      {!query.data ? (
        <div className="p-5">
          <Skeleton className="h-10" />
        </div>
      ) : query.data.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-muted">No incidents in the last 90 days.</p>
      ) : (
        <ul className="max-h-[420px] divide-y divide-border overflow-y-auto">
          {query.data.map((i) => (
            <li key={i.id} className="px-5 py-3">
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-sm font-medium">
                  <span className={`size-1.5 rounded-full ${i.resolved_at ? "bg-subtle" : "bg-down"}`} />
                  {i.resolved_at ? "Resolved" : "Ongoing"}
                </span>
                <span className="mono text-xs text-muted">
                  {duration(i.resolved_at ? i.duration_seconds : (now - Date.parse(i.started_at)) / 1000)}
                </span>
              </div>
              <p className="mono mt-1 truncate text-xs text-muted">{i.cause}</p>
              <p className="mt-0.5 text-xs text-subtle">{dateTime(i.started_at)}</p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
