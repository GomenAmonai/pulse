import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, LogOut } from "lucide-react";
import { motion } from "motion/react";
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate } from "react-router";

import { ThemeToggle } from "../../components/ThemeToggle";
import { DemoBadge, Logo } from "../../components/ui";
import { api, auth } from "../../lib/api";
import { LiveContext, useLive, useLiveConnection } from "./live";

const TABS = [
  { to: "/dashboard", label: "Monitors", end: true },
  { to: "/dashboard/incidents", label: "Incidents" },
  { to: "/dashboard/settings", label: "Notifications" },
];

export function DashboardLayout() {
  if (!auth.get()) return <Navigate to="/login" replace />;
  return <Authenticated />;
}

function Authenticated() {
  const live = useLiveConnection();
  const navigate = useNavigate();
  const client = useQueryClient();
  const location = useLocation();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, staleTime: Infinity });
  const pages = useQuery({ queryKey: ["status-pages"], queryFn: api.statusPages });

  if (me.isError) {
    auth.set(null);
    return <Navigate to="/login" replace />;
  }

  const logout = () => {
    auth.set(null);
    client.clear();
    navigate("/login");
  };
  const page = pages.data?.[0];

  return (
    <LiveContext.Provider value={live}>
      <div className="min-h-dvh bg-bg">
        <header className="material sticky top-0 z-30 border-b border-border">
          <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
            <div className="flex items-center gap-3">
              <Link to="/dashboard" aria-label="Pulse home">
                <Logo />
              </Link>
              <span className="hidden text-border-strong sm:inline">/</span>
              <span className="hidden max-w-[160px] truncate text-sm text-muted sm:inline">{me.data?.email ?? " "}</span>
              <span className="hidden md:inline-flex">
                <DemoBadge />
              </span>
            </div>
            <div className="flex items-center gap-2">
              <LiveIndicator />
              {page && (
                <Link
                  to={`/status/${page.slug}`}
                  className="pressable hidden items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] text-muted hover:bg-surface-2 hover:text-text sm:inline-flex"
                >
                  Status page <ExternalLink className="size-3.5" />
                </Link>
              )}
              <ThemeToggle />
              <button
                type="button"
                onClick={logout}
                className="pressable grid size-8 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-text"
                aria-label="Sign out"
                title="Sign out"
              >
                <LogOut className="size-4" />
              </button>
            </div>
          </div>
          <nav className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-2.5 sm:px-4" aria-label="Sections">
            {TABS.map((tab) => (
              <NavLink
                key={tab.to}
                to={tab.to}
                end={tab.end}
                className={({ isActive }) =>
                  `relative px-2.5 py-3 text-sm whitespace-nowrap transition-colors ${isActive || (tab.end && location.pathname.startsWith("/dashboard/monitors")) ? "text-text" : "text-muted hover:text-text"}`
                }
              >
                {({ isActive }) => (
                  <>
                    {tab.label}
                    {(isActive || (tab.end && location.pathname.startsWith("/dashboard/monitors"))) && (
                      <motion.span
                        layoutId="tab-underline"
                        className="absolute inset-x-2.5 -bottom-px h-0.5 rounded-full bg-text"
                        transition={{ type: "spring", bounce: 0, duration: 0.35 }}
                      />
                    )}
                  </>
                )}
              </NavLink>
            ))}
          </nav>
        </header>
        <main className="mx-auto max-w-6xl px-4 pt-8 pb-20 sm:px-6">
          <Outlet />
        </main>
      </div>
    </LiveContext.Provider>
  );
}

function LiveIndicator() {
  const { connected } = useLive();
  return (
    <span
      className="hidden items-center gap-2 rounded-full border border-border px-2.5 py-1 text-xs text-muted sm:inline-flex"
      title={connected ? "Receiving live updates over server-sent events" : "Reconnecting to the live stream…"}
    >
      <span className="relative inline-flex size-1.5">
        {connected && <span className="ping absolute inset-0 rounded-full bg-up" />}
        <span className={`relative size-1.5 rounded-full ${connected ? "bg-up" : "bg-warn"}`} />
      </span>
      {connected ? "Live" : "Connecting"}
    </span>
  );
}
