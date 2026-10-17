import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useState } from "react";

import { useToast } from "../../components/Toast";
import { subscribe } from "../../lib/api";
import type { Check, LiveEvent, Monitor } from "../../lib/types";

export interface Live {
  connected: boolean;
  /** Id of the latest check per monitor: changes on every check and drives the status dot's beat. */
  beats: Record<number, number>;
}

export const LiveContext = createContext<Live>({ connected: false, beats: {} });
export const useLive = () => useContext(LiveContext);

/** Fold one event into the cached queries, so open pages update without refetching. */
function apply(client: QueryClient, event: LiveEvent) {
  if (event.event === "check") {
    const { monitor_id, status, check } = event.data;
    const patch = (m: Monitor): Monitor =>
      m.id !== monitor_id
        ? m
        : {
            ...m,
            status,
            last_checked_at: check.checked_at,
            last_latency_ms: check.latency_ms,
            consecutive_failures: check.ok ? 0 : m.consecutive_failures + 1,
            consecutive_successes: check.ok ? m.consecutive_successes + 1 : 0,
          };
    client.setQueryData<Monitor[]>(["monitors"], (list) => list?.map(patch));
    client.setQueryData<Monitor>(["monitor", monitor_id], (m) => (m ? patch(m) : m));
    client.setQueryData<Check[]>(["checks", monitor_id], (list) => {
      if (!list) return list;
      const row: Check = { id: Math.floor(Date.parse(check.checked_at) / 1000), ...check };
      return [row, ...list.filter((c) => c.id !== row.id)].slice(0, 50);
    });
    return;
  }
  const id = event.data.monitor_id;
  for (const key of [["monitors"], ["monitor", id], ["incidents"], ["uptime", id], ["latency", id]]) {
    void client.invalidateQueries({ queryKey: key });
  }
}

export function useLiveConnection(): Live {
  const client = useQueryClient();
  const toast = useToast();
  const [connected, setConnected] = useState(false);
  const [beats, setBeats] = useState<Record<number, number>>({});

  useEffect(
    () =>
      subscribe((event) => {
        apply(client, event);
        if (event.event === "check") {
          setBeats((b) => ({ ...b, [event.data.monitor_id]: Date.parse(event.data.check.checked_at) }));
        } else if (event.event === "incident.opened") {
          toast(`${event.data.monitor_name} is down: ${event.data.cause}`, "error");
        } else {
          toast(`${event.data.monitor_name} recovered`, "success");
        }
      }, setConnected),
    [client, toast],
  );

  return { connected, beats };
}
