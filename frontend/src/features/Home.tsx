import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { motion } from "motion/react";
import { Link } from "react-router";

import { ThemeToggle } from "../components/ThemeToggle";
import { UptimeBars } from "../components/UptimeBars";
import { DemoBadge, Logo, Skeleton, StatusDot } from "../components/ui";
import { api } from "../lib/api";
import { pct } from "../lib/format";

const FEATURES = [
  ["Async worker", "Monitors claimed with FOR UPDATE SKIP LOCKED, checked concurrently with httpx under a semaphore."],
  ["Flap protection", "3 failures open an incident, 2 successes close it. One dropped packet pages nobody."],
  ["Stats in SQL", "Uptime and p95 over 24h / 7d / 30d with percentile_cont, date_bin and generate_series."],
  ["Live", "Every check streams to the dashboard over server-sent events through Redis pub/sub."],
  ["Notifications", "Telegram and webhooks signed with HMAC-SHA256, retried with backoff."],
  ["SSRF guard", "Private and metadata addresses are refused, on save and on every redirect hop."],
];

const spring = { type: "spring", bounce: 0, duration: 0.5 } as const;

export function Home() {
  const status = useQuery({ queryKey: ["status", "acme"], queryFn: () => api.publicStatus("acme"), refetchInterval: 10_000 });

  return (
    <div className="min-h-dvh bg-bg">
      <header className="material sticky top-0 z-30 border-b border-border">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4 sm:px-6">
          <Logo />
          <div className="flex items-center gap-2">
            <span className="hidden sm:inline-flex">
              <DemoBadge />
            </span>
            <ThemeToggle />
            <a href="https://github.com/GomenAmonai/pulse" className="hidden rounded-md px-2.5 py-1.5 text-[13px] text-muted hover:text-text sm:block">
              GitHub
            </a>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 sm:px-6">
        <section className="pt-20 pb-14 text-center sm:pt-28">
          <motion.h1
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={spring}
            className="display mx-auto max-w-3xl text-[44px] font-semibold sm:text-[64px]"
          >
            Know it's down before your users do.
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...spring, delay: 0.06 }}
            className="mx-auto mt-5 max-w-xl text-lg text-muted"
          >
            HTTP monitors on a schedule, response times and p95 latency, incidents with flap protection, and a public status page.
          </motion.p>
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...spring, delay: 0.12 }}
            className="mt-9 flex flex-wrap justify-center gap-3"
          >
            <Link to="/login" className="pressable inline-flex h-11 items-center gap-2 rounded-md bg-accent px-5 text-sm font-medium text-accent-fg hover:opacity-85">
              Open the dashboard <ArrowRight className="size-4" />
            </Link>
            <Link to="/status/acme" className="pressable inline-flex h-11 items-center rounded-md border border-border px-5 text-sm font-medium hover:bg-surface-2">
              View a status page
            </Link>
          </motion.div>
        </section>

        <motion.section
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...spring, delay: 0.2 }}
          className="mx-auto max-w-3xl rounded-xl border border-border bg-surface p-2 shadow-[var(--shadow)]"
        >
          <div className="rounded-lg border border-border">
            <div className="flex items-center justify-between border-b border-border px-4 py-3 text-sm">
              <span className="font-medium">{status.data?.title ?? "Acme"} status</span>
              <Link to="/status/acme" className="text-[13px] text-muted hover:text-text">
                /status/acme →
              </Link>
            </div>
            <div className="divide-y divide-border">
              {status.data
                ? status.data.monitors.slice(0, 4).map((m) => (
                    <div key={m.id} className="px-4 py-3.5">
                      <div className="mb-2.5 flex items-center justify-between text-sm">
                        <span className="flex items-center gap-2.5">
                          <StatusDot status={m.status} />
                          {m.name}
                        </span>
                        <span className="mono text-xs text-muted">{pct(m.uptime_90d)}</span>
                      </div>
                      <UptimeBars days={m.days} height={24} />
                    </div>
                  ))
                : Array.from({ length: 4 }, (_, i) => (
                    <div key={i} className="space-y-2.5 px-4 py-3.5">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-6" />
                    </div>
                  ))}
            </div>
          </div>
        </motion.section>

        <section className="grid gap-px overflow-hidden rounded-xl border border-border bg-border py-0 sm:grid-cols-2 lg:grid-cols-3 mt-20 mb-24">
          {FEATURES.map(([title, text]) => (
            <div key={title} className="bg-bg p-6">
              <h3 className="text-sm font-medium">{title}</h3>
              <p className="mt-2 text-sm text-muted">{text}</p>
            </div>
          ))}
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-6 text-[13px] text-muted sm:px-6">
          <span>FastAPI · SQLAlchemy async · PostgreSQL · Redis · React</span>
          <a href="https://github.com/GomenAmonai/pulse" className="hover:text-text">
            Source
          </a>
        </div>
      </footer>
    </div>
  );
}
