import { clusterOf, type Cluster } from "./cluster";
import type { Candle, Token } from "./market";
import { riskGrade, snipeEdge, tokenQuality, type RiskGrade } from "./risk";

export type SetupKind = "setup" | "heat" | "toxic" | "watch";

export interface LabRow {
  tokenId: string;
  symbol: string;
  name: string;
  mint: string;
  live: boolean;
  cluster: Cluster;
  grade: RiskGrade;
  quality: number;
  edge: number;
  ath: number;
  dd: number;
  volMc: number;
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

export function volToMc(vol: number, mc: number): number {
  return mc > 0 ? vol / mc : 0;
}

export function pressureOf(change1m: number): number {
  return Math.max(-1, Math.min(1, change1m / 40));
}

export function setupKind(row: {
  quality: number;
  edge: number;
  dd: number;
  change5m: number;
  freeze: boolean;
  bundled: number;
  live: boolean;
}): SetupKind {
  if (row.freeze || row.quality < 0.28) return "toxic";
  if (!row.live && row.bundled >= 32) return "toxic";
  if (row.dd < 0.08 && row.change5m >= 28) return "heat";
  if (row.edge >= 0.7 && row.quality >= 0.42 && row.dd >= 0.1) return "setup";
  return "watch";
}

export function labRow(tk: Token, now: number): LabRow {
  const ath = athOf(tk.candles, tk.price);
  const dd = drawdown(tk.price, ath);
  const quality = tokenQuality(tk.security, tk.liq, !!tk.live);
  const edge = snipeEdge(tk, now);
  const kind = setupKind({
    quality,
    edge,
    dd,
    change5m: tk.change5m,
    freeze: !!(tk.security.onchain && tk.security.freeze),
    bundled: tk.security.bundled,
    live: !!tk.live,
  });
  return {
    tokenId: tk.id,
    symbol: tk.symbol,
    name: tk.name,
    mint: tk.mint,
    live: !!tk.live,
    cluster: clusterOf(tk.symbol, tk.name),
    grade: riskGrade(quality),
    quality,
    edge,
    ath,
    dd,
    volMc: volToMc(tk.vol, tk.mc),
    pressure: pressureOf(tk.change1m),
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
