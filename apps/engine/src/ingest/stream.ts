/**
 * Push feed over the RPC WebSocket (`logsSubscribe`, one subscription per
 * address). Chosen over HTTP webhooks because a webhook needs a public
 * endpoint and the host has none (ADR-0009); any RPC provider serves this.
 *
 * The collector decides which addresses matter (active mints, followed
 * wallets, the migration authority); this class keeps the socket alive,
 * keeps the subscription set equal to what it was last given, and hands
 * every notification up. It reconnects with backoff and resubscribes.
 */
import WebSocket from "ws";
import { errText, logger } from "../log.ts";

const log = logger("stream");

export type LogEvent = {
  address: string;
  signature: string;
  slot: number;
  err: unknown;
  logs: string[];
  at: number;
};

export type StreamState = {
  connected: boolean;
  lastMessageAt: number | null;
  subscribed: number;
  reconnects: number;
};

type SocketLike = {
  readyState: number;
  send: (data: string) => void;
  ping?: () => void;
  close: () => void;
  terminate?: () => void;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
};

export type StreamOptions = {
  onEvent: (e: LogEvent) => void;
  connect?: (url: string) => SocketLike;
  pingMs?: number;
  staleMs?: number;
  backoffMs?: number;
};

/** wss URL for an https RPC endpoint; the same host serves both on every provider we use. */
export function wsUrlOf(rpcUrl: string): string {
  return rpcUrl.replace(/^https:\/\//, "wss://");
}

export class LogStream {
  readonly state: StreamState = {
    connected: false,
    lastMessageAt: null,
    subscribed: 0,
    reconnects: 0,
  };
  private readonly url: string;
  private readonly opts: Required<StreamOptions>;
  private ws: SocketLike | null = null;
  private wanted = new Set<string>();
  private byAddress = new Map<string, number>();
  private bySub = new Map<number, string>();
  private pending = new Map<number, { address: string; unsub?: true }>();
  private nextId = 1;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private backoff: number;

  constructor(url: string, opts: StreamOptions) {
    this.url = url;
    this.opts = {
      onEvent: opts.onEvent,
      connect: opts.connect ?? ((u) => new WebSocket(u) as unknown as SocketLike),
      pingMs: opts.pingMs ?? 30_000,
      staleMs: opts.staleMs ?? 90_000,
      backoffMs: opts.backoffMs ?? 1000,
    };
    this.backoff = this.opts.backoffMs;
  }

  start(): void {
    this.stopped = false;
    this.open();
    this.timer = setInterval(() => this.keepalive(), this.opts.pingMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.ws?.close();
    this.ws = null;
    this.state.connected = false;
  }

  /** Make the live subscription set equal to `addresses`. Cheap when nothing changed. */
  setAddresses(addresses: Iterable<string>): void {
    this.wanted = new Set(addresses);
    if (!this.state.connected) return;
    for (const a of this.wanted)
      if (!this.byAddress.has(a) && !this.pendingFor(a)) this.subscribe(a);
    for (const [a, sub] of this.byAddress) if (!this.wanted.has(a)) this.unsubscribe(a, sub);
  }

  private pendingFor(address: string): boolean {
    for (const p of this.pending.values()) if (p.address === address && !p.unsub) return true;
    return false;
  }

  private open(): void {
    if (this.stopped) return;
    let ws: SocketLike;
    try {
      ws = this.opts.connect(this.url);
    } catch (e) {
      log.warn("stream connect failed", { err: errText(e) });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.on("open", () => {
      this.state.connected = true;
      this.state.lastMessageAt = Date.now();
      this.backoff = this.opts.backoffMs;
      this.byAddress.clear();
      this.bySub.clear();
      this.pending.clear();
      for (const a of this.wanted) this.subscribe(a);
      log.info("stream connected", { subscriptions: this.wanted.size });
    });
    ws.on("message", (data) => this.onMessage(String(data)));
    ws.on("pong", () => {
      this.state.lastMessageAt = Date.now();
    });
    ws.on("error", (e) => log.warn("stream error", { err: errText(e) }));
    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.state.connected = false;
      this.state.subscribed = 0;
      this.ws = null;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 60_000);
    this.state.reconnects++;
    setTimeout(() => this.open(), wait);
  }

  private keepalive(): void {
    if (!this.ws || !this.state.connected) return;
    const last = this.state.lastMessageAt ?? 0;
    if (Date.now() - last > this.opts.staleMs) {
      log.warn("stream stale, reconnecting");
      const ws = this.ws;
      this.ws = null;
      this.state.connected = false;
      (ws.terminate ?? ws.close).call(ws);
      this.scheduleReconnect();
      return;
    }
    pingSocket(this.ws);
  }

  private send(method: string, params: unknown[]): number {
    const id = this.nextId++;
    this.ws?.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return id;
  }

  private subscribe(address: string): void {
    const id = this.send("logsSubscribe", [{ mentions: [address] }, { commitment: "confirmed" }]);
    this.pending.set(id, { address });
  }

  private unsubscribe(address: string, sub: number): void {
    const id = this.send("logsUnsubscribe", [sub]);
    this.pending.set(id, { address, unsub: true });
    this.byAddress.delete(address);
    this.bySub.delete(sub);
    this.state.subscribed = this.byAddress.size;
  }

  /** Public for tests: one JSON-RPC frame from the node. */
  onMessage(text: string): void {
    this.state.lastMessageAt = Date.now();
    let msg: {
      id?: number;
      result?: unknown;
      error?: { message?: string };
      method?: string;
      params?: {
        subscription?: number;
        result?: {
          context?: { slot?: number };
          value?: { signature?: string; err?: unknown; logs?: string[] };
        };
      };
    };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.id != null) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (!p) return;
      if (msg.error) {
        log.warn("subscription failed", { address: p.address, err: msg.error.message });
        return;
      }
      if (!p.unsub && typeof msg.result === "number") {
        if (this.wanted.has(p.address)) {
          this.byAddress.set(p.address, msg.result);
          this.bySub.set(msg.result, p.address);
        } else {
          this.unsubscribe(p.address, msg.result);
        }
        this.state.subscribed = this.byAddress.size;
      }
      return;
    }
    if (msg.method !== "logsNotification") return;
    const sub = msg.params?.subscription;
    const v = msg.params?.result?.value;
    const address = sub == null ? undefined : this.bySub.get(sub);
    if (!address || !v?.signature) return;
    this.opts.onEvent({
      address,
      signature: v.signature,
      slot: msg.params?.result?.context?.slot ?? 0,
      err: v.err ?? null,
      logs: Array.isArray(v.logs) ? v.logs : [],
      at: Date.now(),
    });
  }
}

function pingSocket(ws: SocketLike): void {
  try {
    if (ws.ping) ws.ping();
    else ws.send(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "getHealth", params: [] }));
  } catch {
    /* the close handler reconnects */
  }
}
