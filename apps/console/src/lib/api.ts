/**
 * The console's only way to talk to the engine. Same origin over the tailnet
 * by default; a bearer token until passkeys land (ADR-0009 §3). Mock mode is
 * all-or-nothing and labelled on every object it returns.
 */
import {
  API_ROUTES,
  type ApiState,
  type FunnelView,
  type IntentDecision,
  type IntentView,
  type PositionView,
  type ReplayRunView,
  type RuleView,
  type TokenView,
  type WsMessage,
} from "@wick/core/api";
import * as mock from "./mock.ts";

const TOKEN_KEY = "wick.token";
const MOCK_KEY = "wick.mock";

export function apiBase(): string {
  return (import.meta.env.VITE_API_BASE as string | undefined) ?? "";
}

export function readToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function writeToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export function isMock(): boolean {
  if (import.meta.env.VITE_MOCK === "1") return true;
  try {
    return localStorage.getItem(MOCK_KEY) === "1";
  } catch {
    return false;
  }
}

export function setMock(on: boolean): void {
  try {
    if (on) localStorage.setItem(MOCK_KEY, "1");
    else localStorage.removeItem(MOCK_KEY);
  } catch {
    /* ignore */
  }
}

export class ApiFailure extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  const token = readToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init.body) headers.set("content-type", "application/json");
  const res = await fetch(apiBase() + path, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      /* not json */
    }
    throw new ApiFailure(res.status, msg);
  }
  return (await res.json()) as T;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const api = {
  state: (): Promise<ApiState> =>
    isMock() ? delay(120).then(() => mock.mockState(Date.now())) : request(API_ROUTES.state),
  intents: (status?: string): Promise<IntentView[]> =>
    isMock()
      ? delay(150).then(() =>
          mock.mockIntents(Date.now()).filter((v) => !status || v.status === status),
        )
      : request(API_ROUTES.intents + (status ? `?status=${encodeURIComponent(status)}` : "")),
  positions: (): Promise<PositionView[]> =>
    isMock()
      ? delay(120).then(() => mock.mockPositions(Date.now()))
      : request(API_ROUTES.positions),
  token: (mint: string): Promise<TokenView> =>
    isMock()
      ? delay(200).then(() => mock.mockToken(mint, Date.now()))
      : request(API_ROUTES.token(mint)),
  funnel: (): Promise<FunnelView> =>
    isMock() ? delay(150).then(() => mock.mockFunnel(Date.now())) : request(API_ROUTES.funnel),
  rules: (): Promise<RuleView[]> =>
    isMock() ? delay(120).then(() => mock.mockRules(Date.now())) : request(API_ROUTES.rules),
  replays: (): Promise<ReplayRunView[]> =>
    isMock() ? delay(120).then(() => mock.mockReplays(Date.now())) : request(API_ROUTES.replays),
  approve: (id: string, body: IntentDecision): Promise<IntentView> =>
    isMock()
      ? delay(200).then(() => {
          const v = mock.mockIntents(Date.now()).find((x) => x.intent.id === id)!;
          return { ...v, status: "approved", decidedBy: body.decidedBy, decidedAt: Date.now() };
        })
      : request(API_ROUTES.approve(id), { method: "POST", body: JSON.stringify(body) }),
  reject: (id: string, body: IntentDecision): Promise<IntentView> =>
    isMock()
      ? delay(200).then(() => {
          const v = mock.mockIntents(Date.now()).find((x) => x.intent.id === id)!;
          return { ...v, status: "rejected", decidedBy: body.decidedBy, decidedAt: Date.now() };
        })
      : request(API_ROUTES.reject(id), { method: "POST", body: JSON.stringify(body) }),
  halt: (reason: string): Promise<{ ok: true }> =>
    isMock()
      ? delay(150).then(() => ({ ok: true as const }))
      : request(API_ROUTES.halt, { method: "POST", body: JSON.stringify({ reason }) }),
};

/** WebSocket with reconnect. In mock mode it emits a state tick every 5 s. */
export function subscribe(
  onMessage: (m: WsMessage) => void,
  onStatus?: (open: boolean) => void,
): () => void {
  if (isMock()) {
    const t = setInterval(
      () => onMessage({ type: "state", state: mock.mockState(Date.now()) }),
      5000,
    );
    onStatus?.(true);
    return () => clearInterval(t);
  }
  let ws: WebSocket | null = null;
  let stopped = false;
  let backoff = 1000;
  const open = () => {
    if (stopped) return;
    const base = apiBase() || window.location.origin;
    const url = new URL(API_ROUTES.ws, base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const token = readToken();
    if (token) url.searchParams.set("token", token);
    ws = new WebSocket(url);
    ws.onopen = () => {
      backoff = 1000;
      onStatus?.(true);
    };
    ws.onmessage = (ev) => {
      try {
        onMessage(JSON.parse(String(ev.data)) as WsMessage);
      } catch {
        /* ignore junk */
      }
    };
    ws.onclose = () => {
      onStatus?.(false);
      if (!stopped) setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    };
    ws.onerror = () => ws?.close();
  };
  open();
  return () => {
    stopped = true;
    ws?.close();
  };
}
