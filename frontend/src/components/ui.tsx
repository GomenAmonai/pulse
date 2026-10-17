import type { ButtonHTMLAttributes, ReactNode } from "react";

import { DEMO } from "../lib/api";
import type { MonitorStatus } from "../lib/types";

export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-semibold title ${className}`}>
      <svg viewBox="0 0 24 24" className="size-5" aria-hidden>
        <rect width="24" height="24" rx="6" fill="currentColor" />
        <path
          d="M4 12.5h3.6l2-5 3.2 10 2.4-6.5 1.3 1.5H20"
          fill="none"
          stroke="var(--bg)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      Pulse
    </span>
  );
}

const DOT: Record<MonitorStatus, string> = {
  up: "bg-up",
  down: "bg-down",
  pending: "bg-subtle",
  paused: "bg-border-strong",
};

export const STATUS_LABEL: Record<MonitorStatus, string> = {
  up: "Up",
  down: "Down",
  pending: "Pending",
  paused: "Paused",
};

/** Status dot; `beatKey` changes on every check and plays a one-shot ring. */
export function StatusDot({ status, beatKey, size = 8 }: { status: MonitorStatus; beatKey?: string | number | null; size?: number }) {
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }} aria-label={STATUS_LABEL[status]} role="img">
      {status === "down" && <span className={`ping absolute inset-0 rounded-full ${DOT[status]}`} />}
      {beatKey != null && status !== "down" && <span key={beatKey} className={`beat absolute inset-0 rounded-full ${DOT[status]}`} />}
      <span className={`relative inline-flex size-full rounded-full transition-colors duration-300 ${DOT[status]}`} />
    </span>
  );
}

export function StatusBadge({ status }: { status: MonitorStatus }) {
  const tone =
    status === "up"
      ? "bg-up-soft text-up"
      : status === "down"
        ? "bg-down-soft text-down"
        : "bg-surface-3 text-muted";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${tone}`}>
      <StatusDot status={status} size={6} />
      {STATUS_LABEL[status]}
    </span>
  );
}

type Variant = "primary" | "secondary" | "ghost" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:opacity-85",
  secondary: "border border-border bg-surface text-text hover:bg-surface-2",
  ghost: "text-muted hover:bg-surface-2 hover:text-text",
  danger: "border border-border bg-surface text-down hover:bg-down-soft",
};

export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" }) {
  return (
    <button
      type="button"
      {...props}
      className={`pressable inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap disabled:pointer-events-none disabled:opacity-50 ${
        size === "sm" ? "h-8 px-3 text-[13px]" : "h-9 px-3.5 text-sm"
      } ${VARIANTS[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-border bg-surface ${className}`}>{children}</div>;
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton rounded-md ${className}`} />;
}

export function DemoBadge({ className = "" }: { className?: string }) {
  if (!DEMO) return null;
  return (
    <span
      title="No backend: the API and the check worker are emulated in your browser with the same contract as the FastAPI server."
      className={`inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted ${className}`}
    >
      <span className="size-1.5 rounded-full bg-warn" />
      Demo mode
    </span>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-medium text-text">{label}</span>
      {children}
      {error ? (
        <span className="mt-1.5 block text-[13px] text-down">{error}</span>
      ) : hint ? (
        <span className="mt-1.5 block text-[13px] text-muted">{hint}</span>
      ) : null}
    </label>
  );
}

/** 16px text so iOS doesn't zoom into the field on focus. */
export const inputClass =
  "h-10 w-full rounded-md border border-border bg-surface px-3 text-base sm:text-sm text-text outline-none transition-colors placeholder:text-subtle hover:border-border-strong focus:border-text aria-invalid:border-down";
