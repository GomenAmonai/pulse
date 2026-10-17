// Mirrors backend/tests/test_flapping.py.
import { describe, expect, it } from "vitest";

import type { MonitorStatus } from "../lib/types";
import { step, type Action } from "./flapping";

function run(sequence: string, status: MonitorStatus = "up", failure_threshold = 3, recovery_threshold = 2) {
  let state = { status, failures: 0, successes: 0 };
  const actions: Action[] = [];
  for (const char of sequence) {
    const [next, action] = step(state, char === ".", { failure_threshold, recovery_threshold });
    state = next;
    if (action) actions.push(action);
  }
  return [state.status, actions];
}

describe("flap protection", () => {
  it.each([
    ["xx", "up", []],
    ["xxx", "down", ["open"]],
    ["xxxxxx", "down", ["open"]],
    ["xx.xx", "up", []],
    ["xxx.", "down", ["open"]],
    ["xxx..", "up", ["open", "resolve"]],
    ["xxx.x..", "up", ["open", "resolve"]],
    ["xxx.x.", "down", ["open"]],
    ["xxx..xxx..", "up", ["open", "resolve", "open", "resolve"]],
  ])("%s → %s", (sequence, status, actions) => {
    expect(run(sequence)).toEqual([status, actions]);
  });

  it("keeps a new monitor pending until a verdict", () => {
    expect(run("xx", "pending")).toEqual(["pending", []]);
    expect(run(".", "pending")).toEqual(["up", []]);
    expect(run("xxx", "pending")).toEqual(["down", ["open"]]);
  });

  it("reacts immediately with thresholds of one", () => {
    expect(run("x.", "up", 1, 1)).toEqual(["up", ["open", "resolve"]]);
  });
});
