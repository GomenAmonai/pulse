import { createHashRouter } from "react-router";

import { Home } from "./features/Home";
import { StatusPage } from "./features/status/StatusPage";

// The dashboard is its own chunk: visitors of a public status page never download it.
const dashboard = () => import("./features/dashboard");

// Hash routing: GitHub Pages has no server-side fallback, so deep links must not hit the server.
export const router = createHashRouter([
  { path: "/", element: <Home /> },
  { path: "/status/:slug", element: <StatusPage /> },
  { path: "/login", lazy: () => dashboard().then((m) => ({ Component: m.LoginPage })) },
  {
    path: "/dashboard",
    lazy: () => dashboard().then((m) => ({ Component: m.DashboardLayout })),
    children: [
      { index: true, lazy: () => dashboard().then((m) => ({ Component: m.MonitorsPage })) },
      { path: "monitors/:id", lazy: () => dashboard().then((m) => ({ Component: m.MonitorDetail })) },
      { path: "incidents", lazy: () => dashboard().then((m) => ({ Component: m.IncidentsPage })) },
      { path: "settings", lazy: () => dashboard().then((m) => ({ Component: m.SettingsPage })) },
    ],
  },
  { path: "*", element: <Home /> },
]);
