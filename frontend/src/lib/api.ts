import { demo, demoFetch } from "../demo/engine";
import { ApiError } from "./errors";
import type {
  Channel,
  ChannelKind,
  Check,
  Day,
  Incident,
  LatencyPoint,
  LiveEvent,
  Monitor,
  MonitorInput,
  PublicStatus,
  RangeKey,
  StatusPage,
  Tokens,
  User,
} from "./types";

const API_URL = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

/**
 * Demo mode answers every call from an in-browser engine that follows the real contract.
 * It is on when no API URL is configured (the GitHub Pages build) or when VITE_DEMO_MODE forces it.
 */
export const DEMO = import.meta.env.VITE_DEMO_MODE ? import.meta.env.VITE_DEMO_MODE === "true" : !API_URL;

const TOKENS_KEY = "pulse-auth";

export const auth = {
  get(): Tokens | null {
    try {
      const raw = localStorage.getItem(TOKENS_KEY);
      return raw ? (JSON.parse(raw) as Tokens) : null;
    } catch {
      return null;
    }
  },
  set(tokens: Tokens | null) {
    try {
      if (tokens) localStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));
      else localStorage.removeItem(TOKENS_KEY);
    } catch {
      /* private mode */
    }
  },
};

interface Options {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  authenticated?: boolean;
}

function buildPath(path: string, query: Options["query"]): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

async function send<T>(path: string, options: Options = {}, retried = false): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { Accept: "application/json" };
  const tokens = options.authenticated === false ? null : auth.get();
  if (tokens) headers.Authorization = `Bearer ${tokens.access}`;
  const url = buildPath(path, options.query);

  if (DEMO) {
    try {
      const { data } = await demoFetch(method, url, options.body, headers);
      return data as T;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(500, { detail: String(error) });
    }
  }

  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(API_URL + url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError(0, { detail: "Can't reach the server. Check your connection and try again." });
  }
  const data = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) {
    // Access tokens are short-lived: refresh once and replay the request.
    if (response.status === 401 && tokens && !retried && (await refresh(tokens))) return send(path, options, true);
    throw new ApiError(response.status, (data ?? {}) as Record<string, unknown>);
  }
  return data as T;
}

let refreshing: Promise<boolean> | null = null;

/** One refresh at a time: parallel 401s share the same request. */
function refresh(tokens: Tokens): Promise<boolean> {
  refreshing ??= send<{ access: string }>("/api/auth/refresh", {
    method: "POST",
    body: { refresh: tokens.refresh },
    authenticated: false,
  })
    .then(({ access }) => {
      auth.set({ ...tokens, access });
      return true;
    })
    .catch(() => {
      auth.set(null);
      return false;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

// --- live events -------------------------------------------------------------------------------

/**
 * Subscribe to /api/stream. It is read with fetch() rather than EventSource, so the token
 * goes in the Authorization header instead of the URL. Reconnects with backoff.
 */
export function subscribe(onEvent: (event: LiveEvent) => void, onState?: (connected: boolean) => void): () => void {
  if (DEMO) {
    onState?.(true);
    const off = demo().subscribe(auth.get()?.access, onEvent);
    return () => {
      off();
      onState?.(false);
    };
  }

  const controller = new AbortController();
  let attempt = 0;

  const connect = async () => {
    while (!controller.signal.aborted) {
      const tokens = auth.get();
      if (!tokens) return;
      try {
        const response = await fetch(`${API_URL}/api/stream`, {
          headers: { Authorization: `Bearer ${tokens.access}`, Accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (response.status === 401) {
          if (!(await refresh(tokens))) return;
          continue;
        }
        if (!response.ok || !response.body) throw new Error(`stream ${response.status}`);
        attempt = 0;
        onState?.(true);
        await readEvents(response.body, onEvent);
      } catch {
        if (controller.signal.aborted) return;
      }
      onState?.(false);
      const delay = Math.min(30_000, 1000 * 2 ** attempt++) * (0.5 + Math.random() / 2);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  };
  void connect();
  return () => controller.abort();
}

async function readEvents(body: ReadableStream<Uint8Array>, onEvent: (event: LiveEvent) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let name = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) name = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length) onEvent({ event: name, data: JSON.parse(data.join("\n")) } as LiveEvent);
    }
  }
}

// --- endpoints -------------------------------------------------------------------------------

export const api = {
  login: async (email: string, password: string) => {
    const tokens = await send<Tokens>("/api/auth/login", { method: "POST", body: { email, password }, authenticated: false });
    auth.set(tokens);
    return tokens;
  },
  register: async (email: string, password: string) => {
    const tokens = await send<Tokens>("/api/auth/register", { method: "POST", body: { email, password }, authenticated: false });
    auth.set(tokens);
    return tokens;
  },
  me: () => send<User>("/api/auth/me"),

  monitors: () => send<Monitor[]>("/api/monitors"),
  monitor: (id: number) => send<Monitor>(`/api/monitors/${id}`),
  createMonitor: (body: Partial<MonitorInput>) => send<Monitor>("/api/monitors", { method: "POST", body }),
  updateMonitor: (id: number, body: Partial<MonitorInput>) => send<Monitor>(`/api/monitors/${id}`, { method: "PATCH", body }),
  deleteMonitor: (id: number) => send<null>(`/api/monitors/${id}`, { method: "DELETE" }),
  pause: (id: number) => send<Monitor>(`/api/monitors/${id}/pause`, { method: "POST" }),
  resume: (id: number) => send<Monitor>(`/api/monitors/${id}/resume`, { method: "POST" }),
  latency: (id: number, range: RangeKey) => send<LatencyPoint[]>(`/api/monitors/${id}/latency`, { query: { range } }),
  uptime: (id: number, days = 90) => send<Day[]>(`/api/monitors/${id}/uptime`, { query: { days } }),
  checks: (id: number, query: { limit?: number; before?: number; failed?: boolean } = {}) =>
    send<Check[]>(`/api/monitors/${id}/checks`, { query }),

  incidents: (query: { state?: "open" | "resolved" | "all"; monitor?: number; limit?: number } = {}) =>
    send<Incident[]>("/api/incidents", { query }),

  statusPages: () => send<StatusPage[]>("/api/status-pages"),
  createStatusPage: (body: { slug: string; title: string; description?: string }) =>
    send<StatusPage>("/api/status-pages", { method: "POST", body }),
  publicStatus: (slug: string) => send<PublicStatus>(`/api/status/${slug}`, { authenticated: false }),

  channels: () => send<Channel[]>("/api/channels"),
  createChannel: (body: { kind: ChannelKind; name: string; target: string }) =>
    send<Channel>("/api/channels", { method: "POST", body }),
  deleteChannel: (id: number) => send<null>(`/api/channels/${id}`, { method: "DELETE" }),
  testChannel: (id: number) => send<{ ok: boolean; detail: string }>(`/api/channels/${id}/test`, { method: "POST" }),
};

export { ApiError };
