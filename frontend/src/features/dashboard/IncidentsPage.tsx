import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";

import { Card, Skeleton } from "../../components/ui";
import { api } from "../../lib/api";
import { dateTime, duration } from "../../lib/format";
import { Segmented } from "./MonitorDetail";
import { useNow } from "./useNow";

type Filter = "All" | "Ongoing" | "Resolved";
const STATE = { All: "all", Ongoing: "open", Resolved: "resolved" } as const;

export function IncidentsPage() {
  const [filter, setFilter] = useState<Filter>("All");
  const query = useQuery({
    queryKey: ["incidents", filter],
    queryFn: () => api.incidents({ state: STATE[filter], limit: 100 }),
    refetchInterval: 30_000,
  });
  const now = useNow();

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold title">Incidents</h1>
          <p className="mt-1 text-sm text-muted">
            An incident opens after a monitor's failure threshold and closes after its recovery threshold.
          </p>
        </div>
        <Segmented value={filter} onChange={setFilter} options={["All", "Ongoing", "Resolved"]} />
      </div>
      <Card className="overflow-hidden">
        <div className="hidden grid-cols-[110px_minmax(0,1fr)_minmax(0,1.4fr)_150px_90px] gap-4 border-b border-border bg-surface-2 px-5 py-2.5 text-xs font-medium text-muted md:grid">
          <span>State</span>
          <span>Monitor</span>
          <span>Cause</span>
          <span>Started</span>
          <span className="text-right">Duration</span>
        </div>
        {!query.data ? (
          <div className="space-y-3 p-5">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-5" />
            ))}
          </div>
        ) : query.data.length === 0 ? (
          <p className="px-5 py-16 text-center text-sm text-muted">Nothing here. Quiet is good.</p>
        ) : (
          <ul className="divide-y divide-border">
            {query.data.map((i) => (
              <li key={i.id}>
                <Link
                  to={`/dashboard/monitors/${i.monitor_id}`}
                  className="hoverable grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 px-5 py-3 text-sm transition-colors md:grid-cols-[110px_minmax(0,1fr)_minmax(0,1.4fr)_150px_90px] md:items-center"
                >
                  <span className="flex items-center gap-2">
                    <span className={`size-1.5 rounded-full ${i.resolved_at ? "bg-subtle" : "bg-down"}`} />
                    <span className={i.resolved_at ? "text-muted" : "font-medium text-down"}>{i.resolved_at ? "Resolved" : "Ongoing"}</span>
                  </span>
                  <span className="mono text-right text-xs md:order-last">
                    {duration(i.resolved_at ? i.duration_seconds : (now - Date.parse(i.started_at)) / 1000)}
                  </span>
                  <span className="truncate font-medium">{i.monitor_name}</span>
                  <span className="mono truncate text-xs text-muted">{i.cause}</span>
                  <span className="text-xs text-muted">{dateTime(i.started_at)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
