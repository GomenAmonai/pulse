export const ms = (value: number | null | undefined) => (value == null ? "—" : `${Math.round(value)} ms`);

/** Uptime with as many decimals as it takes to not round 99.996 up to a lying 100%. */
export function pct(value: number | null | undefined): string {
  if (value == null) return "—";
  if (value === 100) return "100%";
  if (value >= 99.99) return `${value.toFixed(3)}%`;
  return `${value.toFixed(2)}%`;
}

export function duration(seconds: number): string {
  seconds = Math.max(0, Math.round(seconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60 ? ` ${seconds % 60}s` : ""}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

const dateFmt = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });
const dateTimeFmt = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const timeFmt = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const longDateFmt = new Intl.DateTimeFormat("en", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** Daily bars are UTC days (date_trunc in SQL), so they are labelled in UTC. */
export const day = (isoDate: string) => dateFmt.format(new Date(`${isoDate}T00:00:00Z`));
export const longDay = (isoDate: string) => longDateFmt.format(new Date(`${isoDate}T00:00:00Z`));
export const dateTime = (iso: string) => dateTimeFmt.format(new Date(iso));
export const time = (iso: string) => timeFmt.format(new Date(iso));

export const host = (url: string) => {
  try {
    const u = new URL(url);
    return u.host + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return url;
  }
};

/** Bar colour for a day's uptime; null means no data. */
export function uptimeTone(uptime: number | null): "none" | "up" | "warn" | "down" {
  if (uptime == null) return "none";
  if (uptime >= 99.9) return "up";
  if (uptime >= 99) return "warn";
  return "down";
}
