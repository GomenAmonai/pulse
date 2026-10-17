/** 24 hourly latency averages as a tiny line; gaps (no successful checks) break the line. */
export function Sparkline({ values, width = 120, height = 28, tone = "var(--chart)" }: { values: (number | null)[]; width?: number; height?: number; tone?: string }) {
  const present = values.filter((v): v is number => v != null);
  if (present.length < 2) return <svg width={width} height={height} aria-hidden />;
  const max = Math.max(...present);
  const min = Math.min(...present);
  const span = Math.max(max - min, max * 0.25, 1);
  const x = (i: number) => (i / (values.length - 1)) * (width - 2) + 1;
  const y = (v: number) => height - 2 - ((v - min) / span) * (height - 4);

  const segments: string[] = [];
  let current = "";
  values.forEach((v, i) => {
    if (v == null) {
      if (current) segments.push(current);
      current = "";
      return;
    }
    current += `${current ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
  });
  if (current) segments.push(current);
  const lastIndex = values.findLastIndex((v) => v != null);

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden className="overflow-visible">
      {segments.map((d) => (
        <path key={d} d={d} fill="none" stroke={tone} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      ))}
      <circle cx={x(lastIndex)} cy={y(values[lastIndex] as number)} r="2" fill={tone} />
    </svg>
  );
}
