import { clusterOf, type Cluster } from "./cluster";
import type { Candle, Token } from "@wick/core/market";
import { riskGrade, snipeEdge, tokenQuality, type RiskGrade } from "@wick/core/risk";

export type SetupKind = "setup" | "heat" | "toxic" | "watch";

export interface LabRow {
  tokenId: string;
  symbol: string;
  name: string;
  mint: string;
  cluster: Cluster;
  grade: RiskGrade;
  quality: number;
  edge: number;
  ath: number;
  dd: number;
  /** 24h volume over market cap, null when volume is unknown. */
  volMc: number | null;
  pressure: number;
  change5m: number;
  kind: SetupKind;
}

export function athOf(candles: Candle[], price: number): number {
  let ath = Math.max(0, price);
  for (const c of candles) ath = Math.max(ath, c.h, c.c);
  return ath;
}

export function drawdown(price: number, ath: number): number {
  if (!(ath > 0)) return 0;
  return Math.max(0, Math.min(1, (ath - price) / ath));
}

export function volToMc(vol: number | null, mc: number): number | null {
  if (vol == null) return null;
  return mc > 0 ? vol / mc : 0;
}

/** Buy pressure from the 5m buy/sell split, else from the 5m change. */
export function pressureOf(tk: {
  buys5m: number | null;
  sells5m: number | null;
  change5m: number;
}): number {
  if (tk.buys5m != null && tk.sells5m != null && tk.buys5m + tk.sells5m >= 4) {
    return Math.max(-1, Math.min(1, (tk.buys5m - tk.sells5m) / (tk.buys5m + tk.sells5m)));
  }
  return Math.max(-1, Math.min(1, tk.change5m / 40));
}

export function setupKind(row: {
  quality: number;
  edge: number;
  dd: number;
  change5m: number;
  freeze: boolean;
  top10: number | null;
}): SetupKind {
  if (row.freeze || row.quality < 0.28) return "toxic";
  if (row.top10 != null && row.top10 >= 60) return "toxic";
  if (row.dd < 0.08 && row.change5m >= 28) return "heat";
  if (row.edge >= 0.7 && row.quality >= 0.42 && row.dd >= 0.1) return "setup";
  return "watch";
}

export function labRow(tk: Token, now: number): LabRow {
  const ath = athOf(tk.candles, tk.price);
  const dd = drawdown(tk.price, ath);
  const quality = tokenQuality(tk.security, tk.liq);
  const edge = snipeEdge(tk, now);
  const kind = setupKind({
    quality,
    edge,
    dd,
    change5m: tk.change5m,
    freeze: !!(tk.security.onchain && tk.security.freeze),
    top10: tk.security.top10,
  });
  return {
    tokenId: tk.id,
    symbol: tk.symbol,
    name: tk.name,
    mint: tk.mint,
    cluster: clusterOf(tk.symbol, tk.name),
    grade: riskGrade(quality),
    quality,
    edge,
    ath,
    dd,
    volMc: volToMc(tk.vol, tk.mc),
    pressure: pressureOf(tk),
    change5m: tk.change5m,
    kind,
  };
}

export function labBoard(tokens: Token[], now: number): LabRow[] {
  return tokens.map((t) => labRow(t, now)).sort((a, b) => b.edge - a.edge);
}

export function clusterHeat(
  rows: LabRow[],
): Array<{ cluster: Cluster; n: number; avg5m: number; hot: boolean }> {
  const map = new Map<Cluster, { n: number; sum: number }>();
  for (const r of rows) {
    const cur = map.get(r.cluster) ?? { n: 0, sum: 0 };
    cur.n += 1;
    cur.sum += r.change5m;
    map.set(r.cluster, cur);
  }
  return [...map.entries()]
    .map(([cluster, v]) => {
      const avg5m = v.n ? v.sum / v.n : 0;
      return { cluster, n: v.n, avg5m, hot: v.n >= 3 && avg5m >= 18 };
    })
    .sort((a, b) => b.n - a.n || b.avg5m - a.avg5m);
}
