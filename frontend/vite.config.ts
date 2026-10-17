import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// GitHub Pages serves the site from /<repo>/, so production assets need that prefix.
export default defineConfig(({ command, isPreview }) => ({
  base: command === "build" || isPreview ? (process.env.VITE_BASE ?? "/pulse/") : "/",
  plugins: [react(), tailwindcss()],
  // The main chunk is mostly React, Motion, the router and TanStack Query (~170 kB gzipped); the dashboard is split out.
  build: { chunkSizeWarningLimit: 600 },
  test: { environment: "node" },
}));
