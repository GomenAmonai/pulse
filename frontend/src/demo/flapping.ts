// Port of backend/app/services/flapping.py: the demo's simulated worker opens and resolves
// incidents with exactly the same rules as the real one.

import type { MonitorStatus } from "../lib/types";

export type Action = "open" | "resolve";

export interface State {
  status: MonitorStatus;
  failures: number;
  successes: number;
}

export function step(
  state: State,
  ok: boolean,
  thresholds: { failure_threshold: number; recovery_threshold: number },
): [State, Action | null] {
  if (ok) {
    const successes = state.successes + 1;
    if (state.status === "down") {
      if (successes >= thresholds.recovery_threshold) return [{ status: "up", failures: 0, successes }, "resolve"];
      return [{ status: "down", failures: 0, successes }, null];
    }
    return [{ status: "up", failures: 0, successes }, null];
  }
  const failures = state.failures + 1;
  if (state.status !== "down" && failures >= thresholds.failure_threshold) {
    return [{ status: "down", failures, successes: 0 }, "open"];
  }
  return [{ status: state.status, failures, successes: 0 }, null];
}
