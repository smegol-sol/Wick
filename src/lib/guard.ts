/** Shared input, rate, and persist guards. No user URLs — no SSRF surface. */

export const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIG = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const RAW = /^[1-9][0-9]{0,19}$/;
const MAX_QUOTE_LAMPORTS = 50 * 1e9;
const WINDOW = 60_000;
const buckets = new Map<string, number[]>();

export function isB58(raw: string): boolean {
  const s = raw.trim();
  return s.length >= 32 && s.length <= 44 && B58.test(s);
}

export function isSig(raw: string): boolean {
  const s = raw.trim();
  return s.length >= 64 && s.length <= 88 && SIG.test(s);
}

export function amountRawOk(raw: string): boolean {
  return RAW.test(raw.trim());
}

export function clientKey(request: Request): string {
  const xf = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (xf || "local").slice(0, 64);
}

/** True if the call is allowed. */
export function rateLimit(key: string, max: number, windowMs = WINDOW): boolean {
  const now = Date.now();
  const prev = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (prev.length >= max) {
    buckets.set(key, prev);
    return false;
  }
  prev.push(now);
  buckets.set(key, prev);
  if (buckets.size > 500) {
    for (const [k, hits] of buckets) {
      if (!hits.length || now - hits[hits.length - 1] > windowMs * 2) buckets.delete(k);
    }
  }
  return true;
}

/**
 * Browser-originated mutation calls must come from this deployment's own
 * origin. This stops other sites from using the swap/send routes as a proxy
 * for our RPC quota. It is not authentication: a curl user can still call it,
 * and the routes only ever relay signed/unsigned transactions the caller
 * already controls.
 */
export function sameOrigin(request: Request): boolean {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!host) return false;
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  const source = origin ?? referer;
  if (!source) return request.headers.get("sec-fetch-site") == null;
  try {
    return new URL(source).host === host;
  } catch {
    return false;
  }
}

export function jsonHeaders(): HeadersInit {
  return {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}

export function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders() });
}

export function jsonErr(error: string, status: number): Response {
  return jsonOk({ error, ok: false }, status);
}

export function clampNum(n: unknown, lo: number, hi: number, fallback: number): number {
  const x = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.min(hi, Math.max(lo, x));
}

export function sanitizeLabel(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[^\w\s.+\-_$]/g, "")
    .trim()
    .slice(0, max);
}

export function quoteLamportsOk(lamports: number): boolean {
  return Number.isFinite(lamports) && lamports >= 1e6 && lamports <= MAX_QUOTE_LAMPORTS;
}

export function priorityLamportsOk(n: number): boolean {
  return Number.isFinite(n) && n >= 0 && n <= 10_000_000;
}

/** Desk slippage is percent. MEV mode caps 18%. Jupiter wants bps. */
export function slipBps(slippage: unknown, mev = false): number {
  const pct = clampNum(slippage, 0, 80, 12);
  const cap = mev ? Math.min(pct, 18) : pct;
  return Math.round(Math.max(10, Math.min(2000, cap * 100)));
}

export function lruSet<V>(map: Map<string, V>, key: string, value: V, cap: number): void {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > cap) {
    const first = map.keys().next().value;
    if (first == null) break;
    map.delete(first);
  }
}

/** UI amount → integer base units. Float-safe for typical SPL decimals. */
export function uiToRaw(ui: number, decimals: number): string {
  if (!Number.isFinite(ui) || ui <= 0) return "0";
  const d = Math.max(0, Math.min(12, Math.floor(decimals)));
  const fixed = ui.toFixed(d);
  if (fixed.includes("e") || fixed.includes("E")) return "0";
  const [whole, frac = ""] = fixed.split(".");
  const raw = `${whole}${frac.padEnd(d, "0")}`.replace(/^0+/, "");
  return raw || "0";
}

export function liveSellRaw(
  holdAmount: number,
  decimals: number,
  solAmt: number,
  holdSol: number,
): string | null {
  if (!(holdAmount > 0) || !(solAmt > 0) || !(holdSol > 0)) return null;
  const frac = solAmt >= holdSol - 1e-9 ? 1 : Math.min(1, solAmt / holdSol);
  const raw = uiToRaw(holdAmount * frac, decimals);
  return amountRawOk(raw) ? raw : null;
}

export function liveSpendCap(want: number, chainSol: number | null, maxTrade: number): number {
  if (!(want > 0) || chainSol == null || !(chainSol > 0)) return 0;
  const cap = maxTrade > 0 ? Math.min(want, maxTrade, chainSol) : Math.min(want, chainSol);
  return cap >= 0.05 ? cap : 0;
}
