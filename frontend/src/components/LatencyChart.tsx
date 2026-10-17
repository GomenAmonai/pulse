import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { dateTime, ms } from "../lib/format";
import type { LatencyPoint } from "../lib/types";

const PAD = { top: 12, right: 8, bottom: 22, left: 44 };

function niceMax(value: number): number {
  if (value <= 0) return 100;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * magnitude >= value) ?? 10;
  return step * magnitude;
}

/** Average latency as an area, p95 as a line, and red ticks under buckets that had failures. */
export function LatencyChart({ points, height = 220 }: { points: LatencyPoint[]; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const { avgPath, areaPath, p95Path, max, x, y } = useMemo(() => {
    const innerW = width - PAD.left - PAD.right;
    const innerH = height - PAD.top - PAD.bottom;
    const top = niceMax(Math.max(1, ...points.map((p) => p.p95_ms ?? p.avg_ms ?? 0)));
    const x = (i: number) => PAD.left + (points.length > 1 ? (i / (points.length - 1)) * innerW : innerW / 2);
    const y = (v: number) => PAD.top + innerH - (Math.min(v, top) / top) * innerH;
    const line = (key: "avg_ms" | "p95_ms") => {
      let d = "";
      let open = false;
      points.forEach((p, i) => {
        const v = p[key];
        if (v == null) {
          open = false;
          return;
        }
        d += `${open ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
        open = true;
      });
      return d;
    };
    // The area closes each continuous run of data down to the baseline.
    let area = "";
    let run: number[] = [];
    const flush = () => {
      if (run.length > 1) {
        area += `M${x(run[0]).toFixed(1)} ${y(0)}`;
        for (const i of run) area += `L${x(i).toFixed(1)} ${y(points[i].avg_ms as number).toFixed(1)}`;
        area += `L${x(run[run.length - 1]).toFixed(1)} ${y(0)}Z`;
      }
      run = [];
    };
    points.forEach((p, i) => (p.avg_ms == null ? flush() : run.push(i)));
    flush();
    return { avgPath: line("avg_ms"), areaPath: area, p95Path: line("p95_ms"), max: top, x, y };
  }, [points, width, height]);

  const onMove = (clientX: number) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || points.length === 0) return;
    const ratio = (clientX - rect.left - PAD.left) / (width - PAD.left - PAD.right);
    setHover(Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1)))));
  };

  const active = hover == null ? null : points[hover];
  const ticks = [0, max / 2, max];
  const labels = points.length ? [0, Math.floor((points.length - 1) / 2), points.length - 1] : [];

  return (
    <div
      ref={box}
      className="relative touch-pan-y select-none"
      onPointerMove={(e) => onMove(e.clientX)}
      onPointerDown={(e) => onMove(e.clientX)}
      onPointerLeave={() => setHover(null)}
    >
      <svg width={width} height={height} className="block" role="img" aria-label="Response time chart">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeDasharray={t === 0 ? undefined : "2 4"} />
            <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end" className="mono" fontSize="11" fill="var(--subtle)">
              {Math.round(t)}
            </text>
          </g>
        ))}
        <path d={areaPath} fill="var(--chart-fill)" />
        <path d={p95Path} fill="none" stroke="var(--chart-2)" strokeWidth="1.25" strokeDasharray="3 3" />
        <path d={avgPath} fill="none" stroke="var(--chart)" strokeWidth="1.75" strokeLinejoin="round" />
        {points.map((p, i) =>
          p.failures > 0 ? (
            <rect key={p.t} x={x(i) - 1.5} y={height - PAD.bottom + 4} width="3" height="5" rx="1" fill="var(--down)" />
          ) : null,
        )}
        {labels.map((i, n) => (
          <text
            key={i}
            x={x(i)}
            y={height - 4}
            textAnchor={n === 0 ? "start" : n === 2 ? "end" : "middle"}
            fontSize="11"
            fill="var(--subtle)"
          >
            {dateTime(points[i].t)}
          </text>
        ))}
        {active && hover != null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={height - PAD.bottom} stroke="var(--border-strong)" />
            {active.avg_ms != null && <circle cx={x(hover)} cy={y(active.avg_ms)} r="3.5" fill="var(--bg)" stroke="var(--chart)" strokeWidth="1.75" />}
          </g>
        )}
      </svg>
      {active && hover != null && (
        <div
          className="pointer-events-none absolute top-0 z-10 w-44 rounded-lg border border-border bg-surface p-2.5 text-xs shadow-[var(--shadow)]"
          style={{ left: Math.min(Math.max(x(hover) - 88, 0), width - 176) }}
        >
          <div className="font-medium">{dateTime(active.t)}</div>
          <div className="mt-1.5 flex justify-between text-muted">
            <span>Average</span>
            <span className="mono text-text">{ms(active.avg_ms)}</span>
          </div>
          <div className="mt-0.5 flex justify-between text-muted">
            <span>p95</span>
            <span className="mono text-text">{ms(active.p95_ms)}</span>
          </div>
          <div className="mt-0.5 flex justify-between text-muted">
            <span>Checks</span>
            <span className={`mono ${active.failures ? "text-down" : "text-text"}`}>
              {active.checks}
              {active.failures ? ` · ${active.failures} failed` : ""}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
