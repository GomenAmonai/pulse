import { AnimatePresence, motion } from "motion/react";
import { useRef, useState } from "react";

import { duration, longDay, pct, uptimeTone } from "../lib/format";
import type { Day } from "../lib/types";

const TONE = { none: "bg-none", up: "bg-up", warn: "bg-warn", down: "bg-down" };

function tone(d: Day) {
  const base = uptimeTone(d.uptime);
  // A short incident can leave uptime above 99.9%; it still deserves a mark.
  if (base === "up" && d.incidents > 0) return "warn";
  if (base === "none" && d.incidents > 0) return "down";
  return base;
}

/**
 * 90 daily bars, Vercel-status style. One pointer handler on the row picks the bar under
 * the cursor (no per-bar listeners), and the tooltip is anchored to that bar.
 */
export function UptimeBars({ days, height = 32 }: { days: Day[]; height?: number }) {
  const row = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<number | null>(null);

  const pick = (clientX: number) => {
    const rect = row.current?.getBoundingClientRect();
    if (!rect || days.length === 0) return;
    const index = Math.floor(((clientX - rect.left) / rect.width) * days.length);
    setActive(Math.max(0, Math.min(days.length - 1, index)));
  };

  const day = active == null ? null : days[active];
  const left = active == null ? 0 : ((active + 0.5) / days.length) * 100;

  return (
    <div className="relative">
      <div
        ref={row}
        className="flex touch-pan-y items-stretch gap-[2px]"
        style={{ height }}
        onPointerMove={(e) => pick(e.clientX)}
        onPointerDown={(e) => pick(e.clientX)}
        onPointerLeave={() => setActive(null)}
        role="img"
        aria-label={`Daily uptime for the last ${days.length} days`}
      >
        {days.map((d, i) => (
          <div
            key={d.date}
            className={`min-w-0 flex-1 rounded-[2px] transition-[opacity,transform] duration-150 ${TONE[tone(d)]} ${
              active != null && active !== i ? "opacity-60" : ""
            }`}
            style={{ transform: active === i ? "scaleY(1.08)" : undefined }}
          />
        ))}
      </div>
      <AnimatePresence>
        {day && (
          <motion.div
            key="tip"
            initial={{ opacity: 0, y: 4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.97, transition: { duration: 0.1 } }}
            transition={{ type: "spring", bounce: 0, duration: 0.25 }}
            className="pointer-events-none absolute bottom-full z-20 mb-2 w-56 rounded-lg border border-border bg-surface p-3 text-xs shadow-[var(--shadow)]"
            style={{
              left: `clamp(0px, calc(${left}% - 112px), calc(100% - 224px))`,
              transformOrigin: `${Math.min(Math.max(left, 10), 90)}% 100%`,
            }}
          >
            <div className="font-medium text-text">{longDay(day.date)}</div>
            {day.uptime == null ? (
              <div className="mt-1 text-muted">No data</div>
            ) : (
              <>
                <div className="mt-2 flex justify-between text-muted">
                  <span>Uptime</span>
                  <span className="mono text-text">{pct(day.uptime)}</span>
                </div>
                <div className="mt-1 flex justify-between text-muted">
                  <span>Checks</span>
                  <span className="mono text-text">{day.checks.toLocaleString("en")}</span>
                </div>
              </>
            )}
            <div className={`mt-2 flex items-center gap-1.5 border-t border-border pt-2 ${day.incidents ? "text-down" : "text-muted"}`}>
              {day.incidents
                ? `Down ${duration(day.downtime_seconds)} · ${day.incidents} incident${day.incidents > 1 ? "s" : ""}`
                : "No downtime recorded"}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
