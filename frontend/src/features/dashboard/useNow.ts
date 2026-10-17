import { useEffect, useState } from "react";

/** Current time, re-rendering every `step` ms: "12s ago" labels and ongoing durations tick. */
export function useNow(step = 1000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), step);
    return () => clearInterval(id);
  }, [step]);
  return now;
}
