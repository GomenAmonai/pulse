import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, CircleHelp, XCircle } from "lucide-react";
import { motion } from "motion/react";
import { Link, useParams } from "react-router";

import { ThemeToggle } from "../../components/ThemeToggle";
import { UptimeBars } from "../../components/UptimeBars";
import { DemoBadge, Logo, Skeleton, STATUS_LABEL } from "../../components/ui";
import { api, DEMO } from "../../lib/api";
import { ApiError } from "../../lib/errors";
import { dateTime, duration, longDay, pct, time } from "../../lib/format";
import type { Overall, PublicStatus } from "../../lib/types";

const OVERALL: Record<Overall, { label: string; icon: typeof CheckCircle2; tone: string; ring: string }> = {
  operational: { label: "All systems operational", icon: CheckCircle2, tone: "text-up", ring: "bg-up-soft" },
  degraded: { label: "Degraded performance", icon: AlertTriangle, tone: "text-warn", ring: "bg-warn-soft" },
  partial_outage: { label: "Partial outage", icon: AlertTriangle, tone: "text-warn", ring: "bg-warn-soft" },
  major_outage: { label: "Major outage", icon: XCircle, tone: "text-down", ring: "bg-down-soft" },
  unknown: { label: "Status unknown", icon: CircleHelp, tone: "text-muted", ring: "bg-surface-3" },
};

const STATUS_TONE = { up: "text-up", down: "text-down", pending: "text-muted", paused: "text-muted" };

export function StatusPage() {
  const { slug = "acme" } = useParams();
  const query = useQuery({
    queryKey: ["status", slug],
    queryFn: () => api.publicStatus(slug),
    // Polling matches the API's 15 s Cache-Control; a public page needs no live connection.
    refetchInterval: DEMO ? 5_000 : 30_000,
  });

  return (
    <div className="min-h-dvh bg-bg">
      <header className="material sticky top-0 z-30 border-b border-border">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-4 sm:px-6">
          <span className="text-[15px] font-semibold title">{query.data?.title ?? " "}</span>
          <div className="flex items-center gap-2">
            <span className="hidden sm:inline-flex">
              <DemoBadge />
            </span>
            <ThemeToggle />
            <Link to="/login" className="pressable rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-fg hover:opacity-85">
              Dashboard
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 pt-10 pb-16 sm:px-6">
        {query.isPending ? (
          <Loading />
        ) : query.isError ? (
          <NotFound error={query.error} />
        ) : (
          <Content status={query.data} />
        )}
      </main>

      <footer className="mx-auto flex max-w-3xl items-center justify-between border-t border-border px-4 py-6 text-[13px] text-muted sm:px-6">
        <span>
          Powered by <Logo className="ml-1 text-text" />
        </span>
        <a href="https://github.com/GomenAmonai/pulse" className="hover:text-text">
          Source
        </a>
      </footer>
    </div>
  );
}

function Content({ status }: { status: PublicStatus }) {
  const overall = OVERALL[status.status];
  const Icon = overall.icon;
  const open = status.incidents.filter((i) => i.resolved_at == null);

  return (
    <>
      {status.description && <p className="mb-6 text-sm text-muted">{status.description}</p>}

      <motion.section
        key={status.status}
        initial={{ opacity: 0, scale: 0.985 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: "spring", bounce: 0, duration: 0.45 }}
        className="flex items-center gap-4 rounded-xl border border-border bg-surface p-5"
      >
        <span className={`grid size-11 shrink-0 place-items-center rounded-full ${overall.ring}`}>
          <Icon className={`size-6 ${overall.tone}`} strokeWidth={2.25} />
        </span>
        <div className="min-w-0">
          <h1 className="text-xl font-semibold title sm:text-2xl">{overall.label}</h1>
          <p className="mt-0.5 text-[13px] text-muted">
            Updated <span className="mono">{time(status.updated_at)}</span>
            {open.length > 0 && <> · {open.length} ongoing incident{open.length > 1 ? "s" : ""}</>}
          </p>
        </div>
      </motion.section>

      <section className="mt-10">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-medium">System status</h2>
          <span className="text-[13px] text-muted">Last 90 days</span>
        </div>
        <div className="divide-y divide-border rounded-xl border border-border bg-surface">
          {status.monitors.length === 0 && <p className="p-5 text-sm text-muted">No monitors on this page yet.</p>}
          {status.monitors.map((m) => (
            <div key={m.id} className="px-5 pt-4 pb-5">
              <div className="mb-3 flex items-center justify-between gap-3">
                <span className="truncate text-[15px] font-medium">{m.name}</span>
                <span className="flex shrink-0 items-center gap-3 text-[13px]">
                  <span className="mono text-muted">{pct(m.uptime_90d)}</span>
                  <span className={`font-medium ${STATUS_TONE[m.status]}`}>
                    {m.status === "up" ? "Operational" : STATUS_LABEL[m.status]}
                  </span>
                </span>
              </div>
              <UptimeBars days={m.days} />
              <div className="mt-2 flex justify-between text-xs text-subtle">
                <span>90 days ago</span>
                <span>Today</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-12">
        <h2 className="mb-1 text-sm font-medium">Past incidents</h2>
        <p className="mb-4 text-[13px] text-muted">Last 14 days</p>
        <IncidentHistory status={status} />
      </section>
    </>
  );
}

function IncidentHistory({ status }: { status: PublicStatus }) {
  const byDay = new Map<string, PublicStatus["incidents"]>();
  for (const incident of status.incidents) {
    const key = incident.started_at.slice(0, 10);
    byDay.set(key, [...(byDay.get(key) ?? []), incident]);
  }
  const today = new Date(status.updated_at);
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    return d.toISOString().slice(0, 10);
  });

  return (
    <ol className="space-y-6">
      {days.map((d) => (
        <li key={d}>
          <h3 className="border-b border-border pb-2 text-[13px] font-medium">{longDay(d)}</h3>
          {(byDay.get(d) ?? []).length === 0 ? (
            <p className="pt-2 text-[13px] text-subtle">No incidents reported.</p>
          ) : (
            <ul className="space-y-3 pt-3">
              {byDay.get(d)!.map((i) => (
                <li key={i.id} className="text-sm">
                  <div className="flex items-center gap-2">
                    <span className={`size-1.5 rounded-full ${i.resolved_at ? "bg-up" : "bg-down"}`} />
                    <span className="font-medium">
                      {i.monitor_name} {i.resolved_at ? "was unavailable" : "is unavailable"}
                    </span>
                  </div>
                  <p className="mt-1 pl-3.5 text-[13px] text-muted">
                    {i.resolved_at ? "Resolved" : "Ongoing"} · started {dateTime(i.started_at)} · lasted{" "}
                    <span className="mono">{duration(i.duration_seconds)}</span>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
  );
}

function Loading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-[86px] rounded-xl" />
      <div className="space-y-3 rounded-xl border border-border p-5">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="space-y-3 py-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-8" />
          </div>
        ))}
      </div>
    </div>
  );
}

function NotFound({ error }: { error: Error }) {
  const missing = error instanceof ApiError && error.status === 404;
  return (
    <div className="py-24 text-center">
      <h1 className="text-2xl font-semibold title">{missing ? "Status page not found" : "Can't load the status page"}</h1>
      <p className="mt-2 text-sm text-muted">{missing ? "Check the address and try again." : error.message}</p>
      <Link to="/status/acme" className="mt-6 inline-block text-sm underline underline-offset-4">
        Open the demo status page
      </Link>
    </div>
  );
}
